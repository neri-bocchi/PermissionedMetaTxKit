// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA}    from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712}   from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Address}  from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable}  from "@openzeppelin/contracts/access/Ownable.sol";

/// @title PermissionedMetaTxHub
/// @author Luis Ranieri Bocchi
/// @notice On-chain coordination hub for EIP-712 meta-transactions with support for:
///         - Signed caller authorization
///         - Out-of-order nonces (bitmap-based)
///         - Signature cancellation
///         - Authorized relayer allowlist
///         - ERC-1271 contract signature validation
///         - Contract creation via meta-call
///         - Per-block gas quota enforcement
contract PermissionedMetaTxHub is EIP712, Ownable {
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
    // Each 256-bit word tracks 256 nonces for a given (user, space)
    mapping(address => mapping(uint32 => mapping(uint256 => uint256))) private noncesUsed;

    // Digest-based replay protection (scoped by EIP-712 domain: chainId + contract)
    mapping(bytes32 => bool) public usedDigest;

    // ========= Caller allowlist (who can execute meta-txs) =========
    mapping(address => bool) public isCallerAllowed;

    // ========= Per-block gas quota (per caller) =========
    mapping(address => uint256) public gasLimitPerBlock;   // 0 = unlimited
    mapping(address => uint256) private _gasUsedThisBlock; // gas used in current block
    mapping(address => uint64)  private _lastBlockForCaller;
    uint256 public gasAccountingOverhead = 15_000;         // overhead margin (adjustable)

    // ========= Events =========
    event Executed(address indexed from, address indexed to, uint32 indexed space, uint256 nonce, bytes32 dataHash);
    event Canceled(address indexed from, uint32 indexed space, uint256 nonce);
    event ContractDeployed(address indexed signer, address deployed, bytes32 dataHash);
    event CallerAllowedSet(address indexed caller, bool allowed);
    event GasLimitSet(address indexed caller, uint256 limit);
    event GasOverheadSet(uint256 overhead);

    // ========= Structs =========
    struct Forward {
        address from;      // signer authorizing the meta-tx
        address to;        // target contract (or address(0) for CREATE)
        uint256 value;     // ETH value to forward
        uint32  space;     // logical channel (0,1,2...) to parallelize nonces
        uint256 nonce;     // arbitrary nonce (non-sequential)
        uint256 deadline;  // expiration timestamp
        bytes32 dataHash;  // keccak256(data) of the call or creation bytecode
        address caller;    // on-chain executor (must match msg.sender)
    }

    // ========= Constructor =========
    constructor()
        EIP712("PermissionedMetaTxHub", "1")
        Ownable(msg.sender)
    {}

    // ========= Admin functions =========

    /// @notice Add or remove an authorized relayer.
    function setCallerAllowed(address caller, bool allowed) external onlyOwner {
        isCallerAllowed[caller] = allowed;
        emit CallerAllowedSet(caller, allowed);
    }

    /// @notice Set per-block gas quota for a specific relayer.
    /// @dev 0 = unlimited usage.
    function setGasLimitPerBlock(address caller, uint256 limit) external onlyOwner {
        gasLimitPerBlock[caller] = limit;
        emit GasLimitSet(caller, limit);
    }

    /// @notice Set the gas accounting overhead used when enforcing quotas.
    function setGasAccountingOverhead(uint256 overhead) external onlyOwner {
        gasAccountingOverhead = overhead;
        emit GasOverheadSet(overhead);
    }

    // ========= View helpers =========

    /// @notice Returns the gas used by a relayer in the current block and its quota.
    function gasUsedThisBlock(address caller)
        external
        view
        returns (uint256 used, uint256 limit, uint256 blockNo)
    {
        used = _gasUsedThisBlock[caller];
        limit = gasLimitPerBlock[caller];
        blockNo = _lastBlockForCaller[caller];
    }

    /// @notice Checks if a nonce has already been used.
    function isNonceUsed(address user, uint32 space, uint256 nonce) external view returns (bool) {
        (uint256 word, uint256 mask) = _wordAndMask(nonce);
        return (noncesUsed[user][space][word] & mask) != 0;
    }

    // ========= Execution logic =========

    /// @notice Executes an arbitrary call or contract deployment via a signed meta-transaction.
    /// @param f The Forward struct (EIP-712 signed)
    /// @param data The calldata for the target or bytecode for CREATE
    /// @param signature The EIP-712 signature from `f.from`
    function execute(
        Forward calldata f,
        bytes calldata data,
        bytes calldata signature
    ) external payable {
        uint256 gasStart = gasleft();

        // 1) Caller policy
        require(isCallerAllowed[msg.sender], "caller not allowed");
        require(f.caller == msg.sender, "unexpected caller");

        // 2) Basic validation
        require(block.timestamp <= f.deadline, "expired");
        require(keccak256(data) == f.dataHash, "data mismatch");

        // 3) EIP-712 digest + signature verification (EOA or ERC-1271)
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
        require(!usedDigest[digest], "digest used");
        _consumeNonce(f.from, f.space, f.nonce);
        usedDigest[digest] = true;

        // 5) Validate ETH value consistency
        require(msg.value == f.value, "bad msg.value");

        // 6) Execute target call or deploy contract
        if (f.to == address(0)) {
            address deployed;
            assembly {
                deployed := create(callvalue(), add(data.offset, 0x20), data.length)
            }
            require(deployed != address(0), "METATXHUB: create failed");
            emit ContractDeployed(f.from, deployed, f.dataHash);
        } else {
            (bool ok, bytes memory ret) = f.to.call{value: f.value}(data);
            require(ok, _revertMsg(ret));
        }

        // 7) Enforce and update per-block gas quota for the caller
        _enforceAndConsumeCallerGas(gasStart, msg.sender);

        emit Executed(f.from, f.to, f.space, f.nonce, f.dataHash);
    }

    /// @notice Cancels a pending meta-transaction by consuming its nonce.
    /// @param from Signer authorizing the cancellation
    /// @param space Logical space (same used in Forward)
    /// @param nonce Nonce to cancel
    /// @param deadline Expiration time
    /// @param signature EIP-712 signature from the user
    function cancelWithSig(
        address from,
        uint32 space,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(isCallerAllowed[msg.sender], "caller not allowed");
        require(block.timestamp <= deadline, "expired");

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(CANCEL_TYPEHASH, from, space, nonce, deadline))
        );
        _validateSignature(from, digest, signature);

        _consumeNonce(from, space, nonce);
        emit Canceled(from, space, nonce);
    }

    // ========= Internal helpers =========

    /// @dev Verifies either EOA or ERC-1271 signature validity.
    function _validateSignature(address signerOrWallet, bytes32 digest, bytes calldata signature) internal view {
        if (signerOrWallet.code.length > 0) {
            // ERC-1271 wallet
            bytes4 MAGICVALUE = IERC1271.isValidSignature.selector;
            bytes4 ret = IERC1271(signerOrWallet).isValidSignature(digest, signature);
            require(ret == MAGICVALUE, "1271 invalid");
        } else {
            // EOA
            address signer = ECDSA.recover(digest, signature);
            require(signer == signerOrWallet, "bad sig");
        }
    }

    /// @dev Marks a nonce as used within its 256-bit bitmap word.
    function _consumeNonce(address user, uint32 space, uint256 nonce) internal {
        (uint256 word, uint256 mask) = _wordAndMask(nonce);
        uint256 bitmap = noncesUsed[user][space][word];
        require((bitmap & mask) == 0, "nonce used");
        noncesUsed[user][space][word] = bitmap | mask;
    }

    /// @dev Computes bitmap position for a given nonce.
    function _wordAndMask(uint256 nonce) internal pure returns (uint256 word, uint256 mask) {
        unchecked {
            word = nonce >> 8;               // nonce / 256
            uint256 bit = nonce & 0xff;      // nonce % 256
            mask = (uint256(1) << bit);
        }
    }

    /// @dev Enforces per-block gas usage limits for a given caller.
    function _enforceAndConsumeCallerGas(uint256 gasStart, address caller) internal {
        uint256 spent = gasStart - gasleft();
        unchecked { spent += gasAccountingOverhead; }

        // Reset counter if a new block started
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

    /// @dev Decodes revert reasons from failed calls.
    function _revertMsg(bytes memory ret) private pure returns (string memory) {
        if (ret.length < 68) return "call failed";
        assembly { ret := add(ret, 0x04) }
        return abi.decode(ret, (string));
    }

    receive() external payable {}
}