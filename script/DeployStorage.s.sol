// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Storage} from "../contracts/Storage.sol";

/// @notice Despliega el contrato de ejemplo Storage apuntando al hub como trusted
///         forwarder (ERC-2771). Solo redes soportadas por Foundry (amoy).
///
/// Entorno requerido:
///   HUB_ADDRESS    -> dirección del MetaTxForwarder ya desplegado (trusted forwarder)
///   STORAGE_OWNER  -> (opcional) owner del Storage; por defecto el broadcaster
///
/// Uso:
///   HUB_ADDRESS=0x... forge script script/DeployStorage.s.sol:DeployStorage \
///     --rpc-url amoy --private-key 0x$RELAYER_PK --broadcast
contract DeployStorage is Script {
    function run() external returns (Storage store) {
        address hub = vm.envAddress("HUB_ADDRESS");
        address owner = vm.envOr("STORAGE_OWNER", msg.sender);

        vm.startBroadcast();
        store = new Storage(hub, owner);
        vm.stopBroadcast();

        console2.log("Storage deployed at:", address(store));
        console2.log("trustedForwarder:", hub);
        console2.log("owner:", owner);
    }
}
