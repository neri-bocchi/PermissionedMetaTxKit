// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA}           from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712}          from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC1271}        from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Ownable}         from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PermissionedMetaTxHub
/// @author Luis Ranieri Bocchi
/// @notice Hub on-chain para meta-txs EIP-712 con:
///         - Autorización del caller (allowlist)
///         - Nonces fuera de orden (bitmap)
///         - Cancelación por firma
///         - Validación ERC-1271
///         - Deploy por meta-llamada (CREATE)
///         - Cuota de gas por bloque por caller
///         - Protección contra reentrancy
///         - Protección contra gas griefing
/// @dev SECURITY: Este contrato maneja meta-transacciones con múltiples capas de seguridad.
///      El relayer autorizado tiene poder significativo - debe ser confiable.
contract PermissionedMetaTxHub is EIP712, Ownable, ReentrancyGuard {
    using ECDSA for bytes32;

    // ========= Constants =========
    /// @dev Maximum size of return data to copy (prevents gas griefing)
    uint256 private constant MAX_RETURN_DATA_SIZE = 1024;

    // ========= EIP-712 =========
    /// @dev Typehash for Forward struct
    bytes32 private constant FORWARD_TYPEHASH = keccak256(
        "Forward(address from,address to,uint256 value,uint32 space,uint256 nonce,uint256 deadline,bytes32 dataHash,address caller)"
    );
    
    /// @dev Typehash for Cancel struct
    bytes32 private constant CANCEL_TYPEHASH = keccak256(
        "Cancel(address from,uint32 space,uint256 nonce,uint256 deadline)"
    );

    // ========= Nonces (bitmap) =========
    /// @dev Bitmap tracking used nonces per user per space
    /// user => space => word => bitmap
    mapping(address => mapping(uint32 => mapping(uint256 => uint256))) private noncesUsed;

    // ========= Replay por digest =========
    /// @dev Tracks used digests to prevent replay attacks
    mapping(bytes32 => bool) public usedDigest;

    // ========= Allowlist de callers =========
    /// @dev Whitelist of authorized relayers
    mapping(address => bool) public isCallerAllowed;

    // ========= Cuota de gas por bloque =========
    /// @dev Gas limit per block per caller (0 = unlimited)
    mapping(address => uint256) public gasLimitPerBlock;
    
    /// @dev Gas used in current block by caller
    mapping(address => uint256) private _gasUsedThisBlock;
    
    /// @dev Last block number when caller was active
    mapping(address => uint64) private _lastBlockForCaller;
    
    /// @dev Overhead for gas accounting (configurable)
    uint256 public gasAccountingOverhead = 15_000;

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
        bytes32 dataHash;  // keccak256(data) for integrity
        address caller;    // Must match msg.sender (authorized relayer)
    }

    constructor() EIP712("PermissionedMetaTxHub", "1") Ownable(msg.sender) {}

    // ========= Admin =========
    
    /// @notice Authorize or revoke a relayer
    /// @param caller Address of the relayer
    /// @param allowed True to authorize, false to revoke
    function setCallerAllowed(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        isCallerAllowed[caller] = allowed;
        emit CallerAllowedSet(caller, allowed);
    }

    /// @notice Set gas limit per block for a caller
    /// @param caller Address of the relayer
    /// @param limit Gas limit (0 = unlimited)
    function setGasLimitPerBlock(address caller, uint256 limit) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        gasLimitPerBlock[caller] = limit;
        emit GasLimitSet(caller, limit);
    }

    /// @notice Set gas accounting overhead
    /// @param overhead Overhead in gas units
    function setGasAccountingOverhead(uint256 overhead) external onlyOwner {
        gasAccountingOverhead = overhead;
        emit GasOverheadSet(overhead);
    }

    // ========= Views =========
    
    /// @notice Get gas usage statistics for a caller
    /// @param caller Address of the relayer
    /// @return used Gas used in current block
    /// @return limit Gas limit per block
    /// @return blockNo Last active block number
    function gasUsedThisBlock(address caller)
        external
        view
        returns (uint256 used, uint256 limit, uint256 blockNo)
    {
        used = _gasUsedThisBlock[caller];
        limit = gasLimitPerBlock[caller];
        blockNo = _lastBlockForCaller[caller];
    }

    /// @notice Check if a nonce has been used
    /// @param user Address of the user
    /// @param space Nonce space
    /// @param nonce Nonce value
    /// @return True if nonce is used
    function isNonceUsed(address user, uint32 space, uint256 nonce) 
        external 
        view 
        returns (bool) 
    {
        (uint256 word, uint256 mask) = _wordAndMask(nonce);
        return (noncesUsed[user][space][word] & mask) != 0;
    }

    // ========= Ejecución =========
    
    /// @notice Execute a meta-transaction
    /// @dev Protected against reentrancy via nonReentrant modifier
    /// @param f Forward struct containing meta-tx parameters
    /// @param data Calldata or bytecode (for CREATE)
    /// @param signature EIP-712 signature from f.from
    function execute(
        Forward calldata f,
        bytes calldata data,
        bytes calldata signature
    ) external payable nonReentrant {
        uint256 gasStart = gasleft();

        // 1) Validate caller authorization
        if (!isCallerAllowed[msg.sender]) revert CallerNotAllowed();
        if (f.caller != msg.sender) revert UnexpectedCaller();

        // 2) Basic validations
        if (block.timestamp > f.deadline) revert DeadlineExpired();
        if (keccak256(data) != f.dataHash) revert DataMismatch();

        // 3) EIP-712 signature verification (supports EOA and ERC-1271)
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    FORWARD_TYPEHASH,
                    f.from, f.to, f.value, f.space, f.nonce, f.deadline, f.dataHash, f.caller
                )
            )
        );
        _validateSignature(f.from, digest, signature);

        // 4) Replay protection (double layer: digest + nonce)
        if (usedDigest[digest]) revert DigestUsed();
        _consumeNonce(f.from, f.space, f.nonce);
        usedDigest[digest] = true;

        // 5) Validate ETH value
        if (msg.value != f.value) revert BadMsgValue();

        // 6) Execute: CREATE or CALL
        if (f.to == address(0)) {
            _executeCreate(f, data);
        } else {
            _executeCall(f, data);
        }

        // 7) Enforce gas quota per block
        _enforceAndConsumeCallerGas(gasStart, msg.sender);

        // 8) Emit execution event
        emit Executed(f.from, f.to, f.space, f.nonce, f.dataHash, f.caller, f.value);
    }

    /// @notice Cancel a nonce with signature
    /// @param from Address of the signer
    /// @param space Nonce space
    /// @param nonce Nonce to cancel
    /// @param deadline Expiration timestamp
    /// @param signature EIP-712 signature
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
    
    /// @dev Execute CREATE deployment
    /// @param f Forward struct
    /// @param data Bytecode to deploy
    function _executeCreate(Forward calldata f, bytes calldata data) internal {
        bytes memory creation = data;
        address deployed;
        
        assembly {
            deployed := create(callvalue(), add(creation, 0x20), mload(creation))
            
            // If CREATE failed, bubble up the revert reason
            if iszero(deployed) {
                let size := returndatasize()
                // Limit return data size to prevent gas griefing
                if gt(size, MAX_RETURN_DATA_SIZE) {
                    size := MAX_RETURN_DATA_SIZE
                }
                let ptr := mload(0x40)
                returndatacopy(ptr, 0, size)
                revert(ptr, size)
            }
        }
        
        emit ContractDeployed(f.from, deployed, f.dataHash);
    }

    /// @dev Execute external call
    /// @param f Forward struct
    /// @param data Calldata for the target
    function _executeCall(Forward calldata f, bytes calldata data) internal {
        address target = f.to;
        uint256 value = f.value;
        bool success;
        bytes memory returnData;
        
        assembly {
            // Perform the call
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, data.length)
            success := call(
                gas(),
                target,
                value,
                ptr,
                data.length,
                0,
                0
            )
            
            // Copy return data (limited to prevent gas griefing)
            let size := returndatasize()
            if gt(size, MAX_RETURN_DATA_SIZE) {
                size := MAX_RETURN_DATA_SIZE
            }
            
            returnData := mload(0x40)
            mstore(returnData, size)
            returndatacopy(add(returnData, 0x20), 0, size)
            mstore(0x40, add(add(returnData, 0x20), size))
        }
        
        if (!success) revert CallFailed(returnData);
    }

    // ========= Internal Validation & Security =========
    
    /// @dev Validate EIP-712 signature (supports EOA and ERC-1271)
    /// @param signerOrWallet Expected signer address
    /// @param digest EIP-712 digest
    /// @param signature Signature bytes
    function _validateSignature(
        address signerOrWallet,
        bytes32 digest,
        bytes calldata signature
    ) internal view {
        if (signerOrWallet.code.length > 0) {
            // Smart contract wallet - use ERC-1271
            bytes4 magicValue = IERC1271.isValidSignature.selector;
            try IERC1271(signerOrWallet).isValidSignature(digest, signature) returns (bytes4 result) {
                if (result != magicValue) revert InvalidSignature();
            } catch {
                revert InvalidSignature();
            }
        } else {
            // EOA - use ECDSA
            address recovered = ECDSA.recover(digest, signature);
            if (recovered != signerOrWallet) revert InvalidSignature();
        }
    }

    /// @dev Consume a nonce from the bitmap
    /// @param user Address of the user
    /// @param space Nonce space
    /// @param nonce Nonce value
    function _consumeNonce(address user, uint32 space, uint256 nonce) internal {
        (uint256 word, uint256 mask) = _wordAndMask(nonce);
        uint256 bitmap = noncesUsed[user][space][word];
        if ((bitmap & mask) != 0) revert NonceUsed();
        noncesUsed[user][space][word] = bitmap | mask;
    }

    /// @dev Convert nonce to word and bit mask
    /// @param nonce Nonce value
    /// @return word Word index in bitmap
    /// @return mask Bit mask for the nonce
    function _wordAndMask(uint256 nonce) internal pure returns (uint256 word, uint256 mask) {
        unchecked {
            word = nonce >> 8;          // nonce / 256
            uint256 bit = nonce & 0xff; // nonce % 256
            mask = (uint256(1) << bit);
        }
    }

    /// @dev Enforce and track gas usage per block per caller
    /// @param gasStart Gas available at function start
    /// @param caller Address of the relayer
    function _enforceAndConsumeCallerGas(uint256 gasStart, address caller) internal {
        uint256 spent = gasStart - gasleft();
        
        unchecked {
            // Safe: overhead is fixed at ~15k, spent is always < block gas limit
            spent += gasAccountingOverhead;
        }

        // Reset counter if new block
        if (_lastBlockForCaller[caller] != uint64(block.number)) {
            _lastBlockForCaller[caller] = uint64(block.number);
            _gasUsedThisBlock[caller] = 0;
        }

        uint256 newTotal = _gasUsedThisBlock[caller] + spent;
        uint256 limit = gasLimitPerBlock[caller];
        
        // Enforce limit if set (0 = unlimited)
        if (limit != 0 && newTotal > limit) {
            revert BlockGasQuotaExceeded();
        }
        
        _gasUsedThisBlock[caller] = newTotal;
    }

    /// @notice Allows contract to receive ETH
    receive() external payable {}
}