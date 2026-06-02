// scripts/upgrade-proxy.js
const { ethers, upgrades } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    
    // Dirección del proxy existente
    const PROXY_ADDRESS = process.env.PROXY_ADDRESS || "0x..."; // Reemplazar con la dirección real
    
    console.log("Upgrading proxy with account:", deployer.address);
    console.log("Proxy address:", PROXY_ADDRESS);

    // Deploy la nueva implementación
    const MetaTxForwarderV2 = await ethers.getContractFactory("MetaTxForwarderUpgradeable");
    
    console.log("Preparing upgrade...");
    const upgraded = await upgrades.upgradeProxy(PROXY_ADDRESS, MetaTxForwarderV2, {
        kind: 'uups'
    });
    
    await upgraded.waitForDeployment();
    
    console.log("Proxy upgraded successfully!");
    console.log("Proxy address (unchanged):", await upgraded.getAddress());
    console.log("New implementation deployed to:", await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS));
    
    // Verificar la nueva versión
    const version = await upgraded.version();
    console.log("New contract version:", version.toString());
    
    // Si existe un inicializador para v2, llamarlo
    // await upgraded.initializeV2();
    // console.log("V2 initializer executed");
    
    return {
        proxy: await upgraded.getAddress(),
        implementation: await upgrades.erc1967.getImplementationAddress(PROXY_ADDRESS)
    };
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
