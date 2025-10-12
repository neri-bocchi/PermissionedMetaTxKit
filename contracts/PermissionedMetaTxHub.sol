// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA}           from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712}          from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC1271}        from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Ownable}         from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PermissionedMetaTxHub (ERC-2771 compatible)
/// @author Luis Ranieri Bocchi (adaptado para ERC-2771)
/// @notice Hub on-chain para meta-txs EIP-712 con:
///         - Autorización del caller (allowlist)
///         - Nonces fuera de orden (bitmap)
///         - Cancelación por firma
///         - Validación ERC-1271
///         - Deploy por meta-llamada (CREATE)
///         - Cuota de gas por bloque por caller
///         - Protección contra reentrancy
///         - Protección contra gas griefing
///         - **Compatibilidad ERC-2771**: apendea `from` al calldata en llamadas a `to`
/// @dev SECURITY: El relayer autorizado tiene poder significativo - debe ser confiable.
contract PermissionedMetaTxHub is EIP712, Ownable, ReentrancyGuard {
    using ECDSA for bytes32;

    // ========= Constants =========
    /// @dev Maximum size of return data to copy (prevents gas griefing)
    uint256 private constant MAX_RETURN_DATA_SIZE = 1024;

    // ========= EIP-712 =========
    bytes32 private constant FORWARD_TYPEHASH = keccak256(
        "Forward(address from,address to,uint256 value,uint32 space,uint256 nonce,uint256 deadline,bytes32 dataHash,address caller)"
    );
    bytes32 private constant CANCEL_TYPEHASH = keccak256(
        "Cancel(address from,uint32 space,uint256 nonce,uint256 deadline)"
    );

    // ========= Nonces (bitmap) =========
    mapping(address => mapping(uint32 => mapping(uint256 => uint256))) private noncesUsed;

    // ========= Replay por digest =========
    mapping(bytes32 => bool) public usedDigest;

    // ========= Allowlist de callers =========
    mapping(address => bool) public isCallerAllowed;

    // ========= Cuota de gas por bloque =========
    mapping(address => uint256) public gasLimitPerBlock;
    mapping(address => uint256) private _gasUsedThisBlock;
    mapping(address => uint64)  private _lastBlockForCaller;
    uint256 public gasAccountingOverhead = 15_000;

    // ========= ERC-2771 toggle =========
    /// @notice Si es true, al hacer CALL se apendea `f.from` (ERC-2771)
    bool public erc2771AppendSender = true;

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

    // ========= Structs =========
    struct Forward {
        address from;      // Signer of the meta-tx
        address to;        // Target contract (address(0) => CREATE)
        uint256 value;     // ETH value to send
        uint32  space;     // Nonce space for organization
        uint256 nonce;     // Unique nonce (out-of-order allowed)
        uint256 deadline;  // Expiration timestamp
        bytes32 dataHash;  // keccak256(data) para integridad (pre-append)
        address caller;    // Debe coincidir con msg.sender (relayer autorizado)
    }

    constructor() EIP712("PermissionedMetaTxHub", "1") Ownable(msg.sender) {}

    // ========= Admin =========
    function setCallerAllowed(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        isCallerAllowed[caller] = allowed;
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

    /// @notice Activa/desactiva el apéndice ERC-2771 del sender al calldata
    function setErc2771AppendSender(bool enabled) external onlyOwner {
        erc2771AppendSender = enabled;
        emit Erc2771AppendSenderSet(enabled);
    }

    // ========= Views =========
    function gasUsedThisBlock(address caller)
        external
        view
        returns (uint256 used, uint256 limit, uint256 blockNo)
    {
        used = _gasUsedThisBlock[caller];
        limit = gasLimitPerBlock[caller];
        blockNo = _lastBlockForCaller[caller];
    }

    function isNonceUsed(address user, uint32 space, uint256 nonce) 
        external 
        view 
        returns (bool) 
    {
        (uint256 word, uint256 mask) = _wordAndMask(nonce);
        return (noncesUsed[user][space][word] & mask) != 0;
    }

    // ========= Ejecución =========
    function execute(
        Forward calldata f,
        bytes calldata data,
        bytes calldata signature
    ) external payable nonReentrant {
        uint256 gasStart = gasleft();

        // 1) Autorización del caller
        if (!isCallerAllowed[msg.sender]) revert CallerNotAllowed();
        if (f.caller != msg.sender) revert UnexpectedCaller();

        // 2) Validaciones básicas
        if (block.timestamp > f.deadline) revert DeadlineExpired();
        if (keccak256(data) != f.dataHash) revert DataMismatch();

        // 3) Verificación EIP-712 (EOA o ERC-1271)
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    FORWARD_TYPEHASH,
                    f.from, f.to, f.value, f.space, f.nonce, f.deadline, f.dataHash, f.caller
                )
            )
        );
        _validateSignature(f.from, digest, signature);

        // 4) Replay protection
        if (usedDigest[digest]) revert DigestUsed();
        _consumeNonce(f.from, f.space, f.nonce);
        usedDigest[digest] = true;

        // 5) Validación ETH
        if (msg.value != f.value) revert BadMsgValue();

        // 6) Ejecutar
        if (f.to == address(0)) {
            _executeCreate(f, data);
        } else {
            _executeCall(f, data); // <-- ERC-2771 aquí
        }

        // 7) Enforce cuota de gas por bloque
        _enforceAndConsumeCallerGas(gasStart, msg.sender);

        // 8) Evento
        emit Executed(f.from, f.to, f.space, f.nonce, f.dataHash, f.caller, f.value);
    }

    function cancelWithSig(
        address from,
        uint32 space,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (!isCallerAllowed[msg.sender]) revert CallerNotAllowed();
        if (block.timestamp > deadline) revert DeadlineExpired();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(CANCEL_TYPEHASH, from, space, nonce, deadline))
        );
        _validateSignature(from, digest, signature);

        _consumeNonce(from, space, nonce);
        emit Canceled(from, space, nonce);
    }

    // ========= Internal Execution Helpers =========
    function _executeCreate(Forward calldata f, bytes calldata data) internal {
        bytes memory creation = data;
        address deployed;
        
        assembly {
            deployed := create(callvalue(), add(creation, 0x20), mload(creation))
            if iszero(deployed) {
                let size := returndatasize()
                if gt(size, 1024) { size := 1024 }
                let ptr := mload(0x40)
                returndatacopy(ptr, 0, size)
                revert(ptr, size)
            }
        }
        
        emit ContractDeployed(f.from, deployed, f.dataHash);
    }

    /// @dev Llamada externa con compatibilidad ERC-2771:
    ///      payload = data (+ opcionalmente 20 bytes de `f.from` al final)
    function _executeCall(Forward calldata f, bytes calldata data) internal {
        address target = f.to;
        uint256 value = f.value;

        bytes memory payload;
        if (erc2771AppendSender) {
            // ERC-2771: apendear el "sender real"
            payload = abi.encodePacked(data, f.from);
        } else {
            payload = data;
        }

        bool success;
        bytes memory returnData;

        assembly {
            let ptr := add(payload, 0x20)
            let len := mload(payload)
            success := call(gas(), target, value, ptr, len, 0, 0)

            let size := returndatasize()
            if gt(size, 1024) { size := 1024 }

            returnData := mload(0x40)
            mstore(returnData, size)
            returndatacopy(add(returnData, 0x20), 0, size)
            mstore(0x40, add(add(returnData, 0x20), size))
        }
        
        if (!success) revert CallFailed(returnData);
    }

    // ========= Internal Validation & Security =========
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
            address recovered = ECDSA.recover(digest, signature);
            if (recovered != signerOrWallet) revert InvalidSignature();
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
            word = nonce >> 8;          // nonce / 256
            uint256 bit = nonce & 0xff; // nonce % 256
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

    /// @notice Allows contract to receive ETH
    receive() external payable {}
}