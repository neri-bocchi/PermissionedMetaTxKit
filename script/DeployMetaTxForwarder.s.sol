// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MetaTxForwarder} from "../contracts/MetaTxForwarder.sol";

/// @notice Despliega el hub de producción con Foundry en redes EVM estándar (amoy).
///         LACNet (lnettest/lnetmain, gas 0 + tx legacy) se despliega con ethers:
///         ver scripts/deployMetaTxForwarder.js.
///
/// Uso (las claves en .env van SIN 0x, por eso se antepone aquí):
///   forge script script/DeployMetaTxForwarder.s.sol:DeployMetaTxForwarder \
///     --rpc-url amoy --private-key 0x$RELAYER_PK --broadcast --verify
contract DeployMetaTxForwarder is Script {
    function run() external returns (MetaTxForwarder hub) {
        vm.startBroadcast();
        hub = new MetaTxForwarder();
        vm.stopBroadcast();

        console2.log("MetaTxForwarder deployed at:", address(hub));
        console2.log("runtime size (bytes):", address(hub).code.length);
        // Mismo hash que loguea el deploy script de Hardhat (bytecode sin metadata).
        console2.logBytes32(keccak256(address(hub).code));
    }
}
