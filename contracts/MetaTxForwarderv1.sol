// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA}           from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712}          from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC1271}        from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Ownable}         from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EnumerableSet}   from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title MetaTxForwarder (ERC-2771 compatible)
/// @author Luis
/// @notice Hub on-chain para meta-txs EIP-712 con:
///         - Autorización del caller (allowlist de relayers)
///         - Nonces fuera de orden (bitmap)
///         - Cancelación por firma
///         - Validación ERC-1271
///         - Deploy por meta-llamada (CREATE)
///         - Cap de gas por deploy (5M)
///         - 1 deploy por bloque por `from`
///         - Bucket de gas SOLO para deploys (por `from`, configurable)
///         - **Lista blanca de deployers permitidos (allowedDeployers)**
///         - Cuota de gas por bloque por caller
///         - Protección contra reentrancy y gas griefing
///         - **Compatibilidad ERC-2771**: apendea `from` al calldata en llamadas a `to`
contract MetaTxForwarder is EIP712, Ownable, ReentrancyGuard {
    using ECDSA for bytes32;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ========= Constants =========
    uint256 private constant MAX_RETURN_DATA_SIZE = 1024;
    uint256 private constant DEPLOY_GAS_LIMIT = 5_000_000;

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
    uint256 public deployGasBucketLimit    = 10_000_000;
    uint64  public deployGasBucketDuration = 600;
    mapping(address => uint256) private _deployGasUsedInWindow;
    mapping(address => uint64)  private _deployWindowStartedAt;

    // ========= Eventos =========
    event Executed(
        address indexed from,
        address indexed to,
        uint32 indexed space,
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
    event DeployGasBucketConfigSet(uint256 limit, uint64 durationSeconds);
    event AllowedDeployerSet(address indexed account, bool allowed);

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

    struct DeployerInfo {
        address deployer;
        bool allowed;
        uint256 gasUsedInWindow;
        uint64 windowStartedAt;
        uint256 lastDeployBlock;
    }

    constructor() EIP712("PermissionedMetaTxHub", "1") Ownable(msg.sender) {}

    // ========= Admin =========
    function setCallerAllowed(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        isCallerAllowed[caller] = allowed;
        
        if (allowed) {
            _allowedCallers.add(caller);
        } else {
            _allowedCallers.remove(caller);
        }
        
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

    /// @notice Configura el bucket de gas para deploys (por `from`)
    function setDeployGasBucketConfig(uint256 limit, uint64 durationSeconds) external onlyOwner {
        deployGasBucketLimit    = limit;
        deployGasBucketDuration = durationSeconds;
        emit DeployGasBucketConfigSet(limit, durationSeconds);
    }

    /// @notice Permite o bloquea una address para desplegar contratos
    function setAllowedDeployer(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        allowedDeployers[account] = allowed;
        
        if (allowed) {
            _allowedDeployersSet.add(account);
        } else {
            _allowedDeployersSet.remove(account);
        }
        
        emit AllowedDeployerSet(account, allowed);
    }

    /// @notice Batch de allowed deployers
    function setAllowedDeployers(address[] calldata accounts, bool allowed) external onlyOwner {
        uint256 len = accounts.length;
        for (uint256 i; i < len; ) {
            address a = accounts[i];
            if (a == address(0)) revert ZeroAddress();
            allowedDeployers[a] = allowed;
            
            if (allowed) {
                _allowedDeployersSet.add(a);
            } else {
                _allowedDeployersSet.remove(a);
            }
            
            emit AllowedDeployerSet(a, allowed);
            unchecked { ++i; }
        }
    }

    // ========= Views =========
    
    /// @notice Retorna todos los deployers permitidos
    function getAllowedDeployers() external view returns (address[] memory) {
        return _allowedDeployersSet.values();
    }

    /// @notice Retorna el número de deployers permitidos
    function getAllowedDeployersCount() external view returns (uint256) {
        return _allowedDeployersSet.length();
    }

    /// @notice Retorna un deployer permitido por índice (para paginación)
    function getAllowedDeployerAt(uint256 index) external view returns (address) {
        return _allowedDeployersSet.at(index);
    }

    /// @notice Retorna información detallada de un deployer
    function getDeployerInfo(address deployer) external view returns (DeployerInfo memory) {
        return DeployerInfo({
            deployer: deployer,
            allowed: allowedDeployers[deployer],
            gasUsedInWindow: _deployGasUsedInWindow[deployer],
            windowStartedAt: _deployWindowStartedAt[deployer],
            lastDeployBlock: _lastDeployBlockByFrom[deployer]
        });
    }

    /// @notice Retorna información detallada de múltiples deployers
    function getDeployersInfo(address[] calldata deployers) 
        external 
        view 
        returns (DeployerInfo[] memory) 
    {
        uint256 len = deployers.length;
        DeployerInfo[] memory infos = new DeployerInfo[](len);
        
        for (uint256 i; i < len; ) {
            address deployer = deployers[i];
            infos[i] = DeployerInfo({
                deployer: deployer,
                allowed: allowedDeployers[deployer],
                gasUsedInWindow: _deployGasUsedInWindow[deployer],
                windowStartedAt: _deployWindowStartedAt[deployer],
                lastDeployBlock: _lastDeployBlockByFrom[deployer]
            });
            unchecked { ++i; }
        }
        
        return infos;
    }

    /// @notice Retorna todos los callers permitidos
    function getAllowedCallers() external view returns (address[] memory) {
        return _allowedCallers.values();
    }

    /// @notice Retorna el número de callers permitidos
    function getAllowedCallersCount() external view returns (uint256) {
        return _allowedCallers.length();
    }

    function gasUsedThisBlock(address caller)
        external
        view
        returns (uint256 used, uint256 limit, uint256 blockNo)
    {
        used = _gasUsedThisBlock[caller];
        limit = gasLimitPerBlock[caller];
        blockNo = _lastBlockForCaller[caller];
    }

    function deployGasWindowState(address from)
        external
        view
        returns (uint256 used, uint256 limit, uint64 startedAt, uint64 duration, uint256 nowTs)
    {
        used      = _deployGasUsedInWindow[from];
        limit     = deployGasBucketLimit;
        startedAt = _deployWindowStartedAt[from];
        duration  = deployGasBucketDuration;
        nowTs     = block.timestamp;
    }

    // ========= Ejecución =========
    function execute(
        Forward calldata f,
        bytes calldata data,
        bytes calldata signature
    ) external payable nonReentrant {
        uint256 gasStart = gasleft();
        if (!isCallerAllowed[msg.sender]) revert CallerNotAllowed();
        if (f.caller != msg.sender) revert UnexpectedCaller();
        if (block.timestamp > f.deadline) revert DeadlineExpired();
        if (keccak256(data) != f.dataHash) revert DataMismatch();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    FORWARD_TYPEHASH,
                    f.from, f.to, f.value, f.space, f.nonce, f.deadline, f.dataHash, f.caller
                )
            )
        );
        _validateSignature(f.from, digest, signature);

        if (usedDigest[digest]) revert DigestUsed();
        _consumeNonce(f.from, f.space, f.nonce);
        usedDigest[digest] = true;

        if (msg.value != f.value) revert BadMsgValue();

        if (f.to == address(0)) {
            _executeCreate(f, data);
        } else {
            _executeCall(f, data);
        }

        _enforceAndConsumeCallerGas(gasStart, msg.sender);
        emit Executed(f.from, f.to, f.space, f.nonce, f.dataHash, f.caller, f.value);
    }

    // ========= CREATE =========
    function _executeCreate(Forward calldata f, bytes calldata data) internal {
        if (!allowedDeployers[f.from]) revert DeployerNotAllowed();

        uint64 started = _deployWindowStartedAt[f.from];
        uint64 dur     = deployGasBucketDuration;
        if (started == 0 || (dur != 0 && uint64(block.timestamp) >= started + dur)) {
            _deployWindowStartedAt[f.from] = uint64(block.timestamp);
            _deployGasUsedInWindow[f.from] = 0;
        }

        if (_lastDeployBlockByFrom[f.from] == block.number) revert DeployPerBlockExceeded();

        uint256 gasBefore = gasleft();
        address deployed;
        bytes memory creation = data;

        assembly {
            deployed := create(callvalue(), add(creation, 0x20), mload(creation))
            if iszero(deployed) {
                let size := returndatasize()
                if gt(size, MAX_RETURN_DATA_SIZE) { size := MAX_RETURN_DATA_SIZE }
                let ptr := mload(0x40)
                returndatacopy(ptr, 0, size)
                revert(ptr, size)
            }
        }

        uint256 gasAfter = gasleft();
        unchecked {
            uint256 deploySpent = gasBefore - gasAfter;
            if (deploySpent > DEPLOY_GAS_LIMIT) revert DeployGasExceeded();
            uint256 limit = deployGasBucketLimit;
            uint64  dur2   = deployGasBucketDuration;
            if (limit != 0 && dur2 != 0) {
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
        address target = f.to;
        uint256 value = f.value;
        bytes memory payload = erc2771AppendSender ? abi.encodePacked(data, f.from) : data;
        bool success;
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
        address signerOrWallet,
        bytes32 digest,
        bytes calldata signature
    ) internal view {
        if (signerOrWallet.code.length > 0) {
            bytes4 magicValue = IERC1271.isValidSignature.selector;
            try IERC1271(signerOrWallet).isValidSignature(digest, signature) returns (bytes4 result) {
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

    function _wordAndMask(uint256 nonce) internal pure returns (uint256 word, uint256 mask) {
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
            _gasUsedThisBlock[caller] = 0;
        }
        uint256 newTotal = _gasUsedThisBlock[caller] + spent;
        uint256 limit = gasLimitPerBlock[caller];
        if (limit != 0 && newTotal > limit) revert BlockGasQuotaExceeded();
        _gasUsedThisBlock[caller] = newTotal;
    }

    receive() external payable {}
}