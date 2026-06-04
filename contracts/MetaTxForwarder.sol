// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA}           from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712}          from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC1271}        from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Ownable}         from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EnumerableSet}   from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// ─────────────────────────────────────────────────────────────────────────────
// FIX H-02 — DeployProxy
//
// Problema: el opcode CREATE no acepta un parámetro de gas explícito (a
// diferencia de CALL), por lo que el constructor del contrato desplegado puede
// consumir todo el gas del frame del relayer antes de que el check post-facto
// de DEPLOY_GAS_LIMIT lo detecte. El relayer pierde ese gas sin recuperación.
//
// Solución: aislar el CREATE en este contrato auxiliar y llamarlo desde
// MetaTxForwarder con `call{gas: DEPLOY_GAS_LIMIT + DEPLOY_PROXY_OVERHEAD}`.
// De esta forma, el peor caso de gas quemado por el relayer queda acotado
// a DEPLOY_GAS_LIMIT + overhead, independientemente del constructor.
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Proxy auxiliar de deploy con gas acotado.
///      Solo puede ser llamado por el hub (MetaTxForwarder) que lo desplegó.
contract DeployProxy {
    address private immutable _hub;

    constructor() { _hub = msg.sender; }

    /// @notice Despliega `bytecode` con el ETH recibido.
    ///         Si el constructor falla, revierte propagando su revert data.
    function deploy(bytes calldata bytecode)
        external
        payable
        returns (address deployed)
    {
        if (msg.sender != _hub) revert();
        bytes memory bc = bytecode;
        assembly {
            deployed := create(callvalue(), add(bc, 0x20), mload(bc))
            if iszero(deployed) {
                // Propagar el revert data del constructor tal cual.
                let size := returndatasize()
                let ptr  := mload(0x40)
                returndatacopy(ptr, 0, size)
                revert(ptr, size)
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────

/// @title MetaTxForwarder (ERC-2771 compatible)
/// @author Luis
/// @notice Hub on-chain para meta-txs EIP-712 con:
///         - Autorización del caller (allowlist de relayers)
///         - Nonces fuera de orden (bitmap)
///         - Cancelación por firma
///         - Validación ERC-1271
///         - Deploy por meta-llamada (CREATE) con gas acotado vía DeployProxy
///         - Cap de gas por deploy (5 M), aplicado preventivamente (fix H-02)
///         - 1 deploy por bloque por `from`
///         - Bucket de gas personalizado por deployer (configurable individualmente)
///         - Lista blanca de deployers permitidos (allowedDeployers)
///         - Cuota de gas por bloque por caller
///         - Protección contra reentrancy y gas griefing
///         - Compatibilidad ERC-2771: apendea `from` al calldata en llamadas a `to`
///         - Retiro de ETH atrapado (fix H-01)
contract MetaTxForwarder is EIP712, Ownable, ReentrancyGuard {
    using ECDSA for bytes32;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ========= Constants =========
    uint256 private constant MAX_RETURN_DATA_SIZE = 1024;
    uint256 private constant DEPLOY_GAS_LIMIT     = 5_000_000;

    // FIX H-02: overhead de ejecución del DeployProxy excluido el constructor.
    // Cubre: decodificación ABI de bytecode, lectura del immutable _hub,
    // copia a memoria y codificación del valor de retorno.
    // Ajustar si los benchmarks de gas revelan un margen distinto.
    uint256 private constant DEPLOY_PROXY_OVERHEAD = 10_000;

    // ========= EIP-712 =========
    bytes32 private constant FORWARD_TYPEHASH = keccak256(
        "Forward(address from,address to,uint256 value,uint32 space,uint256 nonce,uint256 deadline,bytes32 dataHash,address caller)"
    );
    bytes32 private constant CANCEL_TYPEHASH = keccak256(
        "Cancel(address from,uint32 space,uint256 nonce,uint256 deadline)"
    );

    // ========= Nonces (bitmap) =========
    mapping(address => mapping(uint32 => mapping(uint256 => uint256))) private noncesUsed;

    // ========= Replay protection =========
    mapping(bytes32 => bool) public usedDigest;

    // ========= Allowlist de callers (relayers) =========
    mapping(address => bool) public isCallerAllowed;
    EnumerableSet.AddressSet private _allowedCallers;

    // ========= Cuota de gas por bloque (por caller) =========
    mapping(address => uint256) public gasLimitPerBlock;
    mapping(address => uint256) private _gasUsedThisBlock;
    mapping(address => uint64)  private _lastBlockForCaller;
    uint256 public gasAccountingOverhead = 15_000;

    // ========= ERC-2771 toggle =========
    bool public erc2771AppendSender = true;

    // ========= Lista blanca de deployers permitidos =========
    mapping(address => bool) public allowedDeployers;
    EnumerableSet.AddressSet private _allowedDeployersSet;

    // ========= Control de deploys =========
    mapping(address => uint256) private _lastDeployBlockByFrom;

    // FIX NC-03: rate limit para cancel() invocado directamente por req.from.
    // Impide spam en redes con gas price 0 limitando a 1 cancel directo por
    // address por bloque. Los relayers allowlisteados no están sujetos a este límite.
    mapping(address => uint64) private _lastDirectCancelBlock;

    // ========= Configuración global de deploy (fallback) =========
    uint256 public defaultDeployGasBucketLimit    = 10_000_000;
    uint64  public defaultDeployGasBucketDuration = 600;

    // ========= Configuración personalizada por deployer =========
    struct DeployBucketConfig {
        uint256 gasBucketLimit;
        uint64  gasBucketDuration;
        bool    useCustomConfig;
    }

    mapping(address => DeployBucketConfig) private _deployerConfigs;
    mapping(address => uint256) private _deployGasUsedInWindow;
    mapping(address => uint64)  private _deployWindowStartedAt;

    // FIX H-02: proxy auxiliar para acotar gas en deploys.
    DeployProxy private immutable _deployProxy;

    // ========= Eventos =========
    event Executed(
        address indexed from,
        address indexed to,
        uint32  indexed space,
        uint256 nonce,
        bytes32 dataHash,
        address caller,
        uint256 value
    );
    event Canceled(address indexed from, uint32 indexed space, uint256 nonce);
    event ContractDeployed(address indexed signer, address deployed, bytes32 dataHash);
    event CallerAllowedSet(address indexed caller, bool allowed);
    event GasLimitSet(address indexed caller, uint256 limit);
    event GasOverheadSet(uint256 overhead);
    event Erc2771AppendSenderSet(bool enabled);
    event DefaultDeployGasBucketConfigSet(uint256 limit, uint64 durationSeconds);
    event DeployerBucketConfigSet(
        address indexed deployer, uint256 limit, uint64 durationSeconds, bool useCustom
    );
    event AllowedDeployerSet(address indexed account, bool allowed);
    // FIX H-01: evento para retiros de ETH.
    event Withdrawn(address indexed to, uint256 amount);

    // ========= Errors =========
    error CallerNotAllowed();
    error UnexpectedCaller();
    error DeadlineExpired();
    error DataMismatch();
    error DigestUsed();
    error NonceUsed();
    error BadMsgValue();
    error CreateFailed();
    error CallFailed(bytes returnData);
    error BlockGasQuotaExceeded();
    error ZeroAddress();
    error InvalidSignature();
    error DeployGasExceeded();
    error DeployPerBlockExceeded();
    error DeployTimeWindowGasExceeded();
    error DeployerNotAllowed();
    // FIX H-01: error para retiro fallido.
    error WithdrawFailed();
    // FIX NC-03: error para cancel directo que supera el rate limit.
    error RateLimitExceeded();

    // ========= Structs =========
    struct Forward {
        address from;
        address to;
        uint256 value;
        uint32  space;
        uint256 nonce;
        uint256 deadline;
        bytes32 dataHash;
        address caller;
    }

    /// @dev Payload firmado por el usuario para invalidar un nonce antes de su ejecución.
    struct CancelRequest {
        address from;
        uint32  space;
        uint256 nonce;
        uint256 deadline;
    }

    struct DeployerInfo {
        address deployer;
        bool    allowed;
        uint256 gasUsedInWindow;
        uint64  windowStartedAt;
        uint256 lastDeployBlock;
        uint256 gasBucketLimit;
        uint64  gasBucketDuration;
        bool    useCustomConfig;
    }

    // FIX H-02: desplegar DeployProxy en el constructor del hub.
    constructor() EIP712("PermissionedMetaTxHub", "1") Ownable(msg.sender) {
        _deployProxy = new DeployProxy();
    }

    // ========= Admin =========

    function setCallerAllowed(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        isCallerAllowed[caller] = allowed;
        if (allowed) { _allowedCallers.add(caller); }
        else          { _allowedCallers.remove(caller); }
        emit CallerAllowedSet(caller, allowed);
    }

    function setGasLimitPerBlock(address caller, uint256 limit) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        gasLimitPerBlock[caller] = limit;
        emit GasLimitSet(caller, limit);
    }

    function setGasAccountingOverhead(uint256 overhead) external onlyOwner {
        gasAccountingOverhead = overhead;
        emit GasOverheadSet(overhead);
    }

    function setErc2771AppendSender(bool enabled) external onlyOwner {
        erc2771AppendSender = enabled;
        emit Erc2771AppendSenderSet(enabled);
    }

    /// @notice Configura el bucket de gas predeterminado (fallback) para deploys.
    function setDefaultDeployGasBucketConfig(uint256 limit, uint64 durationSeconds)
        external
        onlyOwner
    {
        defaultDeployGasBucketLimit    = limit;
        defaultDeployGasBucketDuration = durationSeconds;
        emit DefaultDeployGasBucketConfigSet(limit, durationSeconds);
    }

    /// @notice Configura un bucket de gas personalizado para un deployer específico.
    /// @param deployer  La address del deployer.
    /// @param limit     El límite de gas para el bucket (0 = sin límite).
    /// @param durationSeconds Duración del bucket en segundos (0 = ventana permanente).
    /// @param useCustom true para usar config personalizada, false para usar la global.
    function setDeployerBucketConfig(
        address deployer,
        uint256 limit,
        uint64  durationSeconds,
        bool    useCustom
    ) external onlyOwner {
        if (deployer == address(0)) revert ZeroAddress();
        _deployerConfigs[deployer] = DeployBucketConfig({
            gasBucketLimit:    limit,
            gasBucketDuration: durationSeconds,
            useCustomConfig:   useCustom
        });
        emit DeployerBucketConfigSet(deployer, limit, durationSeconds, useCustom);
    }

    /// @notice Batch de configuración de buckets personalizados.
    function setDeployersBucketConfig(
        address[] calldata deployers,
        uint256[] calldata limits,
        uint64[]  calldata durations,
        bool[]    calldata useCustoms
    ) external onlyOwner {
        uint256 len = deployers.length;
        require(
            len == limits.length && len == durations.length && len == useCustoms.length,
            "Length mismatch"
        );
        for (uint256 i; i < len; ) {
            address deployer = deployers[i];
            if (deployer == address(0)) revert ZeroAddress();
            _deployerConfigs[deployer] = DeployBucketConfig({
                gasBucketLimit:    limits[i],
                gasBucketDuration: durations[i],
                useCustomConfig:   useCustoms[i]
            });
            emit DeployerBucketConfigSet(deployer, limits[i], durations[i], useCustoms[i]);
            unchecked { ++i; }
        }
    }

    /// @notice Permite o bloquea una address para desplegar contratos.
    function setAllowedDeployer(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        allowedDeployers[account] = allowed;
        if (allowed) { _allowedDeployersSet.add(account); }
        else          { _allowedDeployersSet.remove(account); }
        emit AllowedDeployerSet(account, allowed);
    }

    /// @notice Batch de allowed deployers.
    function setAllowedDeployers(address[] calldata accounts, bool allowed)
        external
        onlyOwner
    {
        uint256 len = accounts.length;
        for (uint256 i; i < len; ) {
            address a = accounts[i];
            if (a == address(0)) revert ZeroAddress();
            allowedDeployers[a] = allowed;
            if (allowed) { _allowedDeployersSet.add(a); }
            else          { _allowedDeployersSet.remove(a); }
            emit AllowedDeployerSet(a, allowed);
            unchecked { ++i; }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // FIX H-01 — Retiro de ETH atrapado
    //
    // Problema: receive() acepta ETH sin ningún mecanismo de recuperación;
    // cualquier ETH enviado directamente al contrato quedaba bloqueado
    // permanentemente.
    //
    // Solución: función de retiro restringida al owner.
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Retira `amount` wei del balance del contrato hacia `to`.
    ///         Solo el owner puede invocarla.
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, amount);
    }

    // ========= Views =========

    /// @notice Retorna todos los deployers permitidos.
    function getAllowedDeployers() external view returns (address[] memory) {
        return _allowedDeployersSet.values();
    }

    /// @notice Retorna el número de deployers permitidos.
    function getAllowedDeployersCount() external view returns (uint256) {
        return _allowedDeployersSet.length();
    }

    /// @notice Retorna un deployer permitido por índice (para paginación).
    function getAllowedDeployerAt(uint256 index) external view returns (address) {
        return _allowedDeployersSet.at(index);
    }

    /// @notice Retorna la configuración del bucket para un deployer.
    function getDeployerBucketConfig(address deployer)
        external
        view
        returns (uint256 limit, uint64 duration, bool useCustom)
    {
        DeployBucketConfig memory config = _deployerConfigs[deployer];
        if (config.useCustomConfig) {
            return (config.gasBucketLimit, config.gasBucketDuration, true);
        } else {
            return (defaultDeployGasBucketLimit, defaultDeployGasBucketDuration, false);
        }
    }

    /// @notice Retorna información detallada de un deployer.
    function getDeployerInfo(address deployer) external view returns (DeployerInfo memory) {
        DeployBucketConfig memory config = _deployerConfigs[deployer];
        uint256 limit;
        uint64  duration;
        if (config.useCustomConfig) {
            limit    = config.gasBucketLimit;
            duration = config.gasBucketDuration;
        } else {
            limit    = defaultDeployGasBucketLimit;
            duration = defaultDeployGasBucketDuration;
        }
        return DeployerInfo({
            deployer:         deployer,
            allowed:          allowedDeployers[deployer],
            gasUsedInWindow:  _deployGasUsedInWindow[deployer],
            windowStartedAt:  _deployWindowStartedAt[deployer],
            lastDeployBlock:  _lastDeployBlockByFrom[deployer],
            gasBucketLimit:   limit,
            gasBucketDuration: duration,
            useCustomConfig:  config.useCustomConfig
        });
    }

    /// @notice Retorna información detallada de múltiples deployers.
    function getDeployersInfo(address[] calldata deployers)
        external
        view
        returns (DeployerInfo[] memory)
    {
        uint256 len = deployers.length;
        DeployerInfo[] memory infos = new DeployerInfo[](len);
        for (uint256 i; i < len; ) {
            address deployer = deployers[i];
            DeployBucketConfig memory config = _deployerConfigs[deployer];
            uint256 limit;
            uint64  duration;
            if (config.useCustomConfig) {
                limit    = config.gasBucketLimit;
                duration = config.gasBucketDuration;
            } else {
                limit    = defaultDeployGasBucketLimit;
                duration = defaultDeployGasBucketDuration;
            }
            infos[i] = DeployerInfo({
                deployer:          deployer,
                allowed:           allowedDeployers[deployer],
                gasUsedInWindow:   _deployGasUsedInWindow[deployer],
                windowStartedAt:   _deployWindowStartedAt[deployer],
                lastDeployBlock:   _lastDeployBlockByFrom[deployer],
                gasBucketLimit:    limit,
                gasBucketDuration: duration,
                useCustomConfig:   config.useCustomConfig
            });
            unchecked { ++i; }
        }
        return infos;
    }

    /// @notice Retorna todos los callers permitidos.
    function getAllowedCallers() external view returns (address[] memory) {
        return _allowedCallers.values();
    }

    /// @notice Retorna el número de callers permitidos.
    function getAllowedCallersCount() external view returns (uint256) {
        return _allowedCallers.length();
    }

    function gasUsedThisBlock(address caller)
        external
        view
        returns (uint256 used, uint256 limit, uint256 blockNo)
    {
        used    = _gasUsedThisBlock[caller];
        limit   = gasLimitPerBlock[caller];
        blockNo = _lastBlockForCaller[caller];
    }

    // ─────────────────────────────────────────────────────────────────────
    // FIX M-02 — deployGasWindowState retorna estado efectivo
    //
    // Problema: el reset de la ventana de gas solo ocurría en _executeCreate
    // (reset lazy). La view retornaba el gas acumulado de una ventana ya
    // expirada, haciendo creer a callers externos que el deployer estaba
    // "en cuota" cuando en realidad su contador se reiniciaría en el próximo
    // deploy.
    //
    // Solución: simular el reset lazy dentro de la propia view.
    // ─────────────────────────────────────────────────────────────────────

    function deployGasWindowState(address from)
        external
        view
        returns (
            uint256 used,
            uint256 limit,
            uint64  startedAt,
            uint64  duration,
            uint256 nowTs
        )
    {
        DeployBucketConfig memory config = _deployerConfigs[from];
        nowTs = block.timestamp;

        if (config.useCustomConfig) {
            limit    = config.gasBucketLimit;
            duration = config.gasBucketDuration;
        } else {
            limit    = defaultDeployGasBucketLimit;
            duration = defaultDeployGasBucketDuration;
        }

        startedAt = _deployWindowStartedAt[from];

        // FIX M-02: si la ventana expiró, devolver el estado efectivo (cero),
        // igual a lo que haría _executeCreate en el próximo deploy.
        if (startedAt != 0 && duration != 0 && uint64(nowTs) >= startedAt + duration) {
            used      = 0;
            startedAt = 0;
        } else {
            used = _deployGasUsedInWindow[from];
        }
    }

    // ========= Ejecución =========

    // ─────────────────────────────────────────────────────────────────────
    // FIX M-03 — BadMsgValue verificado antes de consumir el nonce
    //
    // Problema: la comprobación `msg.value != f.value` se realizaba DESPUÉS
    // de _consumeNonce y usedDigest = true, ambas escrituras irrecuperables.
    // Un relayer que enviase ETH incorrecto por error quemaba el nonce del
    // usuario, obligándolo a re-firmar con un nonce distinto.
    //
    // Solución: mover la comprobación al bloque de validaciones previas,
    // antes de cualquier escritura de estado.
    // ─────────────────────────────────────────────────────────────────────

    function execute(
        Forward calldata f,
        bytes calldata data,
        bytes calldata signature
    ) external payable nonReentrant {
        uint256 gasStart = gasleft();

        // ── Validaciones baratas (sin escritura de estado) ──────────────
        if (!isCallerAllowed[msg.sender])  revert CallerNotAllowed();
        if (f.caller != msg.sender)        revert UnexpectedCaller();
        if (block.timestamp > f.deadline)  revert DeadlineExpired();
        if (keccak256(data) != f.dataHash) revert DataMismatch();

        // FIX M-03: verificar ETH ANTES de cualquier escritura de estado.
        if (msg.value != f.value) revert BadMsgValue();

        // ── Validación de firma ─────────────────────────────────────────
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    FORWARD_TYPEHASH,
                    f.from, f.to, f.value, f.space, f.nonce,
                    f.deadline, f.dataHash, f.caller
                )
            )
        );
        _validateSignature(f.from, digest, signature);

        // ── Escrituras de estado (replay protection) ────────────────────
        if (usedDigest[digest]) revert DigestUsed();
        _consumeNonce(f.from, f.space, f.nonce);
        usedDigest[digest] = true;

        // ── Ejecución ───────────────────────────────────────────────────
        if (f.to == address(0)) {
            _executeCreate(f, data);
        } else {
            _executeCall(f, data);
        }

        _enforceAndConsumeCallerGas(gasStart, msg.sender);
        emit Executed(f.from, f.to, f.space, f.nonce, f.dataHash, f.caller, f.value);
    }

    // ─────────────────────────────────────────────────────────────────────
    // FIX C-01 — Cancelación de nonce por firma
    //
    // Problema: CANCEL_TYPEHASH estaba definido y documentado en la NatSpec
    // pero ninguna función del contrato lo usaba. Un usuario que firmase una
    // meta-tx y luego quisiera revocarla (clave comprometida, arrepentimiento,
    // cambio de condiciones) no tenía ningún mecanismo on-chain y debía esperar
    // pasivamente a que expirase el deadline.
    //
    // Solución: cancel() valida la firma EIP-712 del CancelRequest, consume el
    // nonce en el bitmap (impidiendo cualquier execute posterior con ese nonce)
    // y emite Canceled. Puede invocarla el propio req.from (sin intermediario)
    // o cualquier caller allowlisteado, de modo que el usuario no dependa de la
    // disponibilidad del relayer para protegerse.
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Invalida un nonce firmado, impidiendo su ejecución futura.
    /// @dev    Puede llamarla `req.from` directamente o un caller allowlisteado.
    ///         Una vez cancelado el nonce, cualquier `execute` con ese mismo
    ///         (from, space, nonce) revertirá con `NonceUsed`.
    /// @param req  Struct con los campos (from, space, nonce, deadline) a cancelar.
    /// @param signature Firma EIP-712 de `req` producida por `req.from`
    ///                  (ECDSA para EOAs, ERC-1271 para smart-contract wallets).
    function cancel(
        CancelRequest calldata req,
        bytes calldata signature
    ) external nonReentrant {
        // Permitir: el propio firmante OR un relayer allowlisteado.
        if (msg.sender != req.from && !isCallerAllowed[msg.sender])
            revert CallerNotAllowed();

        // FIX NC-03: cuando el firmante llama directamente (sin relayer),
        // aplicar rate limit de 1 cancel por bloque para prevenir spam en
        // redes con gas price 0. Los relayers allowlisteados quedan exentos:
        // son actores de confianza y pueden enviar múltiples cancels por bloque.
        if (msg.sender == req.from && !isCallerAllowed[msg.sender]) {
            if (_lastDirectCancelBlock[msg.sender] == uint64(block.number))
                revert RateLimitExceeded();
            _lastDirectCancelBlock[msg.sender] = uint64(block.number);
        }

        // Un CancelRequest expirado es inútil (el forward ya no puede ejecutarse).
        if (block.timestamp > req.deadline) revert DeadlineExpired();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CANCEL_TYPEHASH,
                    req.from,
                    req.space,
                    req.nonce,
                    req.deadline
                )
            )
        );

        // Valida firma ECDSA (EOA) o ERC-1271 (smart-contract wallet).
        _validateSignature(req.from, digest, signature);

        // Marcar el nonce como usado: cualquier execute posterior con este
        // (from, space, nonce) revertirá con NonceUsed.
        _consumeNonce(req.from, req.space, req.nonce);

        emit Canceled(req.from, req.space, req.nonce);
    }

    // ========= CREATE =========

    // ─────────────────────────────────────────────────────────────────────
    // FIX H-02 — Gas del relayer acotado usando DeployProxy
    // FIX M-01 — Gas bucket activo cuando limit > 0, independiente de dur
    //
    // Problema H-02: véase contrato DeployProxy arriba.
    //
    // Problema M-01: la condición original `(limit != 0 && dur != 0)` exigía
    // que ambos parámetros fuesen no-cero para activar el tracking. Configurar
    // limit=5_000_000, dur=0 (ventana permanente sin expiración) deshabilitaba
    // silenciosamente el límite. La nueva condición `limit != 0` aplica el
    // límite siempre que esté definido, con o sin ventana temporal.
    // ─────────────────────────────────────────────────────────────────────

    function _executeCreate(Forward calldata f, bytes calldata data) internal {
        if (!allowedDeployers[f.from]) revert DeployerNotAllowed();

        // Resolver configuración del bucket para este deployer.
        DeployBucketConfig memory config = _deployerConfigs[f.from];
        uint256 limit;
        uint64  dur;
        if (config.useCustomConfig) {
            limit = config.gasBucketLimit;
            dur   = config.gasBucketDuration;
        } else {
            limit = defaultDeployGasBucketLimit;
            dur   = defaultDeployGasBucketDuration;
        }

        // Resetear ventana si expiró o es la primera vez.
        uint64 started = _deployWindowStartedAt[f.from];
        if (started == 0 || (dur != 0 && uint64(block.timestamp) >= started + dur)) {
            _deployWindowStartedAt[f.from] = uint64(block.timestamp);
            _deployGasUsedInWindow[f.from] = 0;
        }

        if (_lastDeployBlockByFrom[f.from] == block.number) revert DeployPerBlockExceeded();

        // FIX H-02: llamar al proxy con gas acotado en lugar de CREATE directo.
        //           Si el constructor excede DEPLOY_GAS_LIMIT, el sub-call falla
        //           y el gas quemado por el relayer queda limitado a
        //           DEPLOY_GAS_LIMIT + DEPLOY_PROXY_OVERHEAD (aprox).
        uint256 gasBefore = gasleft();
        (bool ok, bytes memory ret) = address(_deployProxy).call{
            gas:   DEPLOY_GAS_LIMIT + DEPLOY_PROXY_OVERHEAD,
            value: f.value
        }(abi.encodeWithSelector(DeployProxy.deploy.selector, data));

        if (!ok) {
            if (ret.length == 0) revert DeployGasExceeded(); // el sub-call agotó el gas
            // Propagar el revert data del constructor (truncado a MAX_RETURN_DATA_SIZE).
            assembly {
                let size := mload(ret)
                if gt(size, MAX_RETURN_DATA_SIZE) { size := MAX_RETURN_DATA_SIZE }
                revert(add(ret, 0x20), size)
            }
        }

        address deployed = abi.decode(ret, (address));

        unchecked {
            uint256 deploySpent = gasBefore - gasleft();

            // FIX M-01: verificar límite independientemente de `dur`.
            //           Antes: `if (limit != 0 && dur != 0)` → dur=0 anulaba el límite.
            //           Ahora: `if (limit != 0)` → el límite aplica siempre que exista.
            if (limit != 0) {
                uint256 newTotal = _deployGasUsedInWindow[f.from] + deploySpent;
                if (newTotal > limit) revert DeployTimeWindowGasExceeded();
                _deployGasUsedInWindow[f.from] = newTotal;
            }
        }

        _lastDeployBlockByFrom[f.from] = block.number;
        emit ContractDeployed(f.from, deployed, f.dataHash);
    }

    // ========= CALL =========
    function _executeCall(Forward calldata f, bytes calldata data) internal {
        address target  = f.to;
        uint256 value   = f.value;
        bytes memory payload = erc2771AppendSender
            ? abi.encodePacked(data, f.from)
            : data;
        bool  success;
        bytes memory returnData;
        assembly {
            let ptr := add(payload, 0x20)
            let len := mload(payload)
            success := call(gas(), target, value, ptr, len, 0, 0)
            let size := returndatasize()
            if gt(size, MAX_RETURN_DATA_SIZE) { size := MAX_RETURN_DATA_SIZE }
            returnData := mload(0x40)
            mstore(returnData, size)
            returndatacopy(add(returnData, 0x20), 0, size)
            mstore(0x40, add(add(returnData, 0x20), size))
        }
        if (!success) revert CallFailed(returnData);
    }

    // ========= Helpers =========
    function _validateSignature(
        address         signerOrWallet,
        bytes32         digest,
        bytes calldata  signature
    ) internal view {
        if (signerOrWallet.code.length > 0) {
            bytes4 magicValue = IERC1271.isValidSignature.selector;
            try IERC1271(signerOrWallet).isValidSignature(digest, signature)
                returns (bytes4 result)
            {
                if (result != magicValue) revert InvalidSignature();
            } catch {
                revert InvalidSignature();
            }
        } else {
            if (ECDSA.recover(digest, signature) != signerOrWallet)
                revert InvalidSignature();
        }
    }

    function _consumeNonce(address user, uint32 space, uint256 nonce) internal {
        (uint256 word, uint256 mask) = _wordAndMask(nonce);
        uint256 bitmap = noncesUsed[user][space][word];
        if ((bitmap & mask) != 0) revert NonceUsed();
        noncesUsed[user][space][word] = bitmap | mask;
    }

    function _wordAndMask(uint256 nonce)
        internal
        pure
        returns (uint256 word, uint256 mask)
    {
        unchecked {
            word = nonce >> 8;
            uint256 bit = nonce & 0xff;
            mask = (uint256(1) << bit);
        }
    }

    function _enforceAndConsumeCallerGas(uint256 gasStart, address caller) internal {
        uint256 spent = gasStart - gasleft();
        unchecked { spent += gasAccountingOverhead; }
        if (_lastBlockForCaller[caller] != uint64(block.number)) {
            _lastBlockForCaller[caller] = uint64(block.number);
            _gasUsedThisBlock[caller]   = 0;
        }
        uint256 newTotal = _gasUsedThisBlock[caller] + spent;
        uint256 limit    = gasLimitPerBlock[caller];
        if (limit != 0 && newTotal > limit) revert BlockGasQuotaExceeded();
        _gasUsedThisBlock[caller] = newTotal;
    }

    receive() external payable {}
}
