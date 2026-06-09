// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MetaTxForwarder} from "../../contracts/MetaTxForwarder.sol";
import {Storage} from "../../contracts/Storage.sol";

/// @notice Smoke test del flujo completo: un firmante off-chain autoriza una
///         llamada, el relayer allowlisteado la ejecuta vía execute() y el hub
///         reenvía el calldata a Storage recuperando al firmante real por ERC-2771.
contract MetaTxForwarderTest is Test {
    MetaTxForwarder internal hub;
    Storage internal store;

    address internal owner = makeAddr("owner");      // owner del hub
    address internal relayer = makeAddr("relayer");  // caller allowlisteado
    address internal signerAddr;                     // f.from (firma la meta-tx)
    uint256 internal signerPk;

    bytes32 constant FORWARD_TYPEHASH = keccak256(
        "Forward(address from,address to,uint256 value,uint32 space,uint256 nonce,uint256 deadline,bytes32 dataHash,address caller)"
    );

    function setUp() public {
        (signerAddr, signerPk) = makeAddrAndKey("signer");

        vm.prank(owner);
        hub = new MetaTxForwarder();

        // Storage confía en el hub como trusted forwarder (ERC-2771).
        store = new Storage(address(hub), owner);

        // El owner allowlistea al relayer.
        vm.prank(owner);
        hub.setCallerAllowed(relayer, true);
    }

    function test_OwnerAndAllowlist() public view {
        assertEq(hub.owner(), owner);
        assertTrue(hub.isCallerAllowed(relayer));
    }

    function test_Execute_ForwardsCallAndRecoversSender() public {
        // Calldata objetivo: store(42). El dataHash se firma SOBRE este calldata,
        // antes de que el hub apenda los 20 bytes de f.from por ERC-2771.
        bytes memory data = abi.encodeWithSelector(Storage.store.selector, uint256(42));

        MetaTxForwarder.Forward memory f = MetaTxForwarder.Forward({
            from: signerAddr,
            to: address(store),
            value: 0,
            space: 0,
            nonce: 1,
            deadline: block.timestamp + 1 hours,
            dataHash: keccak256(data),
            caller: relayer
        });

        bytes memory sig = _sign(f);

        // _msgSender() en Storage debe recuperar al firmante (no al relayer ni al hub).
        vm.expectEmit(true, false, false, true, address(store));
        emit Storage.NumberStored(42, signerAddr);

        vm.prank(relayer);
        hub.execute(f, data, sig);

        assertEq(store.retrieve(), 42);
        // El nonce queda consumido: un replay revierte.
        vm.prank(relayer);
        vm.expectRevert();
        hub.execute(f, data, sig);
    }

    function test_Execute_RevertsForNonAllowlistedCaller() public {
        bytes memory data = abi.encodeWithSelector(Storage.store.selector, uint256(7));
        MetaTxForwarder.Forward memory f = MetaTxForwarder.Forward({
            from: signerAddr,
            to: address(store),
            value: 0,
            space: 0,
            nonce: 2,
            deadline: block.timestamp + 1 hours,
            dataHash: keccak256(data),
            caller: address(0xBEEF)
        });
        bytes memory sig = _sign(f);

        vm.prank(address(0xBEEF));
        vm.expectRevert(MetaTxForwarder.CallerNotAllowed.selector);
        hub.execute(f, data, sig);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _sign(MetaTxForwarder.Forward memory f) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            FORWARD_TYPEHASH,
            f.from, f.to, f.value, f.space, f.nonce, f.deadline, f.dataHash, f.caller
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domainSeparator() internal view returns (bytes32) {
        // EIP-712 domain del hub vía ERC-5267: name="PermissionedMetaTxHub", version="1".
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,)
            = hub.eip712Domain();
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes(name)),
            keccak256(bytes(version)),
            chainId,
            verifyingContract
        ));
    }
}
