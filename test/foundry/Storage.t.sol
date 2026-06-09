// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Storage} from "../../contracts/Storage.sol";

contract StorageTest is Test {
    Storage internal store;
    address internal owner = makeAddr("owner");

    function setUp() public {
        // trustedForwarder irrelevante aquí: estos tests llaman directo (no vía hub).
        store = new Storage(address(0xF0), owner);
    }

    function test_InitialState() public view {
        assertEq(store.owner(), owner);
        assertEq(store.retrieve(), 0);
    }

    function test_StoreAndRetrieve() public {
        store.store(42);
        assertEq(store.retrieve(), 42);
    }

    function test_StoreEmitsEventWithMsgSender() public {
        // Llamada directa: _msgSender() == address(this).
        vm.expectEmit(true, false, false, true, address(store));
        emit Storage.NumberStored(42, address(this));
        store.store(42);
    }

    function testFuzz_StoreAndRetrieve(uint256 n) public {
        store.store(n);
        assertEq(store.retrieve(), n);
    }
}
