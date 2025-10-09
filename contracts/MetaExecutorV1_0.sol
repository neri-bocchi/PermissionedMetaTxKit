// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title MetaExecutor 1.0
/// @notice Meta-executor genérico con EIP-712, nonces fuera de orden y cancelación.

contract MetaExecutorV1_0 is EIP712 {
    using ECDSA for bytes32;

    // ===== EIP-712 =====
    // Forward(from,to,value,space,nonce,deadline,dataHash)
    bytes32 private constant FORWARD_TYPEHASH = keccak256(
        "Forward(address from,address to,uint256 value,uint32 space,uint256 nonce,uint256 deadline,bytes32 dataHash)"
    );
    // Cancel(from,space,nonce,deadline)
    bytes32 private constant CANCEL_TYPEHASH = keccak256(
        "Cancel(address from,uint32 space,uint256 nonce,uint256 deadline)"
    );

    // ===== Nonce bitmap por usuario y espacio =====
    // Bitmap con palabras de 256 bits. Cada palabra cubre 256 nonces.
    // noncesUsed[user][space][word] -> bits usados
    mapping(address => mapping(uint32 => mapping(uint256 => uint256))) private noncesUsed;

    // (Opcional) digest usado para idempotencia extra (misma red/contrato)
    mapping(bytes32 => bool) public usedDigest;

    event Executed(address indexed from, address indexed to, uint32 indexed space, uint256 nonce, bytes32 dataHash);
    event Canceled(address indexed from, uint32 indexed space, uint256 nonce);

    constructor() EIP712("MetaExecutor", "1") {}

    struct Forward {
        address from;      // quien autoriza
        address to;        // contrato destino
        uint256 value;     // ETH a reenviar
        uint32  space;     // canal lógico (0,1,2...) para paralelizar
        uint256 nonce;     // cualquiera (fuera de orden)
        uint256 deadline;  // timestamp límite
        bytes32 dataHash;  // keccak256(data) de la llamada
    }

    /// @notice Ejecuta una llamada arbitraria si la firma EIP-712 es válida.
    /// @param f struct Forward (con dataHash = keccak256(data))
    /// @param data calldata para `f.to` (encodeFunctionData)
    /// @param signature firma del `f.from` sobre el struct EIP-712
    function execute(
        Forward calldata f,
        bytes calldata data,
        bytes calldata signature
    ) external payable {
        require(block.timestamp <= f.deadline, "expired");
        require(keccak256(data) == f.dataHash, "data mismatch");

        // digest EIP-712
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    FORWARD_TYPEHASH,
                    f.from,
                    f.to,
                    f.value,
                    f.space,
                    f.nonce,
                    f.deadline,
                    f.dataHash
                )
            )
        );

        // validar firma
        address signer = ECDSA.recover(digest, signature);
        require(signer == f.from, "bad sig");

        // opcional: idempotencia adicional (misma red/contrato)
        require(!usedDigest[digest], "digest used");

        // marcar nonce usado (bitmap)
        _consumeNonce(f.from, f.space, f.nonce);

        // marcar digest usado
        usedDigest[digest] = true;

        // reenviar ETH si corresponde (el relayer debe mandar msg.value == f.value)
        require(msg.value == f.value, "bad msg.value");

        // ejecutar destino
        (bool ok, bytes memory ret) = f.to.call{value: f.value}(data);
        require(ok, _revertMsg(ret));

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
        require(block.timestamp <= deadline, "expired");

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(CANCEL_TYPEHASH, from, space, nonce, deadline))
        );

        address signer = ECDSA.recover(digest, signature);
        require(signer == from, "bad sig");

        _consumeNonce(from, space, nonce);
        emit Canceled(from, space, nonce);
    }

    /// @notice Devuelve si un nonce ya fue usado.
    function isNonceUsed(address user, uint32 space, uint256 nonce) external view returns (bool) {
        (uint256 word, uint256 mask) = _wordAndMask(nonce);
        return (noncesUsed[user][space][word] & mask) != 0;
    }

    // ===== Internals =====

    function _consumeNonce(address user, uint32 space, uint256 nonce) internal {
        (uint256 word, uint256 mask) = _wordAndMask(nonce);
        uint256 bitmap = noncesUsed[user][space][word];
        require((bitmap & mask) == 0, "nonce used");
        noncesUsed[user][space][word] = bitmap | mask;
    }

    function _wordAndMask(uint256 nonce) internal pure returns (uint256 word, uint256 mask) {
        unchecked {
            word = nonce >> 8;              // /256
            uint256 bit = nonce & 0xff;     // %256
            mask = (1 << bit);
        }
    }

    function _revertMsg(bytes memory ret) private pure returns (string memory) {
        if (ret.length < 68) return "call failed";
        assembly {
            ret := add(ret, 0x04)
        }
        return abi.decode(ret, (string));
    }

    receive() external payable {}
}
