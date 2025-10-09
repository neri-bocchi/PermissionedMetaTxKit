// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA}    from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712}   from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Address}  from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable}  from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MetaExecutor 1.1
/// @notice Meta-executor genérico con EIP-712 (caller firmado), nonces fuera de orden,
///         cancelación, allowlist de callers, soporte ERC-1271, CREATE y cuotas de gas por bloque.

contract MetaExecutor1_1 is EIP712, Ownable {
    using ECDSA for bytes32;

    // ========= EIP-712 =========
    // Forward(from,to,value,space,nonce,deadline,dataHash,caller)
    bytes32 private constant FORWARD_TYPEHASH = keccak256(
        "Forward(address from,address to,uint256 value,uint32 space,uint256 nonce,uint256 deadline,bytes32 dataHash,address caller)"
    );
    // Cancel(from,space,nonce,deadline)
    bytes32 private constant CANCEL_TYPEHASH = keccak256(
        "Cancel(address from,uint32 space,uint256 nonce,uint256 deadline)"
    );

    // ========= Nonces (bitmap) =========
    // noncesUsed[user][space][word] -> bits usados; cada palabra cubre 256 nonces
    mapping(address => mapping(uint32 => mapping(uint256 => uint256))) private noncesUsed;

    // Idempotencia extra por digest (namespaced por EIP712 domain: chainId + contract)
    mapping(bytes32 => bool) public usedDigest;

    // ========= Allowlist de callers (quién puede invocar execute/cancel) =========
    mapping(address => bool) public isCallerAllowed;

    // ========= Cuotas de gas por bloque (por caller) =========
    mapping(address => uint256) public gasLimitPerBlock;   // 0 = sin límite
    mapping(address => uint256) private _gasUsedThisBlock; // gas usado en el bloque actual por caller
    mapping(address => uint64)  private _lastBlockForCaller;
    uint256 public gasAccountingOverhead = 15_000;         // margen para contabilidad (ajustable)

    // ========= Eventos =========
    event Executed(address indexed from, address indexed to, uint32 indexed space, uint256 nonce, bytes32 dataHash);
    event Canceled(address indexed from, uint32 indexed space, uint256 nonce);
    event ContractDeployed(address indexed signer, address deployed, bytes32 dataHash);
    event CallerAllowedSet(address indexed caller, bool allowed);
    event GasLimitSet(address indexed caller, uint256 limit);
    event GasOverheadSet(uint256 overhead);

    // ========= Structs =========
    struct Forward {
        address from;      // quien autoriza
        address to;        // contrato destino (o address(0) para CREATE)
        uint256 value;     // ETH a reenviar
        uint32  space;     // canal lógico (0,1,2...) para paralelizar
        uint256 nonce;     // cualquiera (fuera de orden)
        uint256 deadline;  // timestamp límite
        bytes32 dataHash;  // keccak256(data) de la llamada (o bytecode si CREATE)
        address caller;    // quién está autorizado a ejecutar on-chain (debe ser msg.sender)
    }

    // ========= Constructor =========
    constructor()
        EIP712("MetaExecutor", "1")
        Ownable(msg.sender)
    {}

    // ========= Administración =========
    function setCallerAllowed(address caller, bool allowed) external onlyOwner {
        isCallerAllowed[caller] = allowed;
        emit CallerAllowedSet(caller, allowed);
    }

    function setGasLimitPerBlock(address caller, uint256 limit) external onlyOwner {
        gasLimitPerBlock[caller] = limit; // 0 = sin límite
        emit GasLimitSet(caller, limit);
    }

    function setGasAccountingOverhead(uint256 overhead) external onlyOwner {
        gasAccountingOverhead = overhead;
        emit GasOverheadSet(overhead);
    }

    // ========= Vista útil =========
    function gasUsedThisBlock(address caller) external view returns (uint256 used, uint256 limit, uint256 blockNo) {
        used = _gasUsedThisBlock[caller];
        limit = gasLimitPerBlock[caller];
        blockNo = _lastBlockForCaller[caller];
    }

    /// @notice Devuelve si un nonce ya fue usado.
    function isNonceUsed(address user, uint32 space, uint256 nonce) external view returns (bool) {
        (uint256 word, uint256 mask) = _wordAndMask(nonce);
        return (noncesUsed[user][space][word] & mask) != 0;
    }

    // ========= Ejecución =========

    /// @notice Ejecuta una llamada arbitraria si la firma EIP-712 es válida.
    /// @param f struct Forward (con dataHash = keccak256(data))
    /// @param data calldata para `f.to` (encodeFunctionData) o bytecode de creación si f.to==0
    /// @param signature firma del `f.from` sobre el struct EIP-712
    function execute(
        Forward calldata f,
        bytes calldata data,
        bytes calldata signature
    ) external payable {
        uint256 gasStart = gasleft();

        // 1) Policies de caller
        require(isCallerAllowed[msg.sender], "caller not allowed");
        require(f.caller == msg.sender, "unexpected caller");

        // 2) Guardas básicas
        require(block.timestamp <= f.deadline, "expired");
        require(keccak256(data) == f.dataHash, "data mismatch");

        // 3) Digest EIP-712 + validación firma (EOA o ERC-1271)
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    FORWARD_TYPEHASH,
                    f.from, f.to, f.value, f.space, f.nonce, f.deadline, f.dataHash, f.caller
                )
            )
        );
        _validateSignature(f.from, digest, signature);

        // 4) Anti-replay
        require(!usedDigest[digest], "digest used");
        _consumeNonce(f.from, f.space, f.nonce);
        usedDigest[digest] = true;

        // 5) Valor esperado
        require(msg.value == f.value, "bad msg.value");

        // 6) Ejecutar: CREATE o CALL
        if (f.to == address(0)) {
            address deployed;
            // data = bytecode de creación (constructor incluido)
            assembly {
                deployed := create(callvalue(), add(data.offset, 0x20), data.length)
            }
            require(deployed != address(0), "create failed");
            emit ContractDeployed(f.from, deployed, f.dataHash);
        } else {
            (bool ok, bytes memory ret) = f.to.call{value: f.value}(data);
            require(ok, _revertMsg(ret));
        }

        // 7) Contabilidad y cuota de gas por bloque/caller (opcional)
        _enforceAndConsumeCallerGas(gasStart, msg.sender);

        emit Executed(f.from, f.to, f.space, f.nonce, f.dataHash);
    }

    /// @notice Cancela (quema) un nonce pendiente por firma EIP-712.
    function cancelWithSig(
        address from,
        uint32 space,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(isCallerAllowed[msg.sender], "caller not allowed"); // opcional: exigir que lo tramite un caller válido
        require(block.timestamp <= deadline, "expired");

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(CANCEL_TYPEHASH, from, space, nonce, deadline))
        );
        _validateSignature(from, digest, signature);

        _consumeNonce(from, space, nonce);
        emit Canceled(from, space, nonce);
    }

    // ========= Internals =========

    function _validateSignature(address signerOrWallet, bytes32 digest, bytes calldata signature) internal view {
        if (signerOrWallet.code.length > 0) {
            // ERC-1271
            bytes4 MAGICVALUE = IERC1271.isValidSignature.selector; // 0x1626ba7e
            bytes4 ret = IERC1271(signerOrWallet).isValidSignature(digest, signature);
            require(ret == MAGICVALUE, "1271 invalid");
        } else {
            // EOA
            address signer = ECDSA.recover(digest, signature);
            require(signer == signerOrWallet, "bad sig");
        }
    }

    function _consumeNonce(address user, uint32 space, uint256 nonce) internal {
        (uint256 word, uint256 mask) = _wordAndMask(nonce);
        uint256 bitmap = noncesUsed[user][space][word];
        require((bitmap & mask) == 0, "nonce used");
        noncesUsed[user][space][word] = bitmap | mask;
    }

    function _wordAndMask(uint256 nonce) internal pure returns (uint256 word, uint256 mask) {
        unchecked {
            word = nonce >> 8;               // /256
            uint256 bit = nonce & 0xff;      // %256
            mask = (uint256(1) << bit);
        }
    }

    function _enforceAndConsumeCallerGas(uint256 gasStart, address caller) internal {
        uint256 spent = gasStart - gasleft();
        unchecked { spent += gasAccountingOverhead; }

        // reset por cambio de bloque
        if (_lastBlockForCaller[caller] != uint64(block.number)) {
            _lastBlockForCaller[caller] = uint64(block.number);
            _gasUsedThisBlock[caller] = 0;
        }

        uint256 newTotal = _gasUsedThisBlock[caller] + spent;
        uint256 limit = gasLimitPerBlock[caller];
        if (limit != 0) {
            require(newTotal <= limit, "block gas quota exceeded");
        }
        _gasUsedThisBlock[caller] = newTotal;
    }

    function _revertMsg(bytes memory ret) private pure returns (string memory) {
        if (ret.length < 68) return "call failed";
        assembly { ret := add(ret, 0x04) }
        return abi.decode(ret, (string));
    }

    receive() external payable {}
}