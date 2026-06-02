// scripts/deploy-proxy.js
import hre from "hardhat";

async function main() {
    const { ethers, upgrades } = hre;
    const [deployer] = await ethers.getSigners();
    
    console.log("Deploying contracts with account:", deployer.address);
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Account balance:", ethers.formatEther(balance), "ETH");

    // Deploy el contrato implementation y el proxy
    const MetaTxForwarder = await ethers.getContractFactory("MetaTxForwarderUpgradeable");
    
    console.log("Deploying MetaTxForwarder proxy...");
    const proxy = await upgrades.deployProxy(
        MetaTxForwarder,
        [deployer.address], // initialOwner
        { 
            initializer: 'initialize',
            kind: 'uups'
        }
    );
    
    await proxy.waitForDeployment();
    const proxyAddress = await proxy.getAddress();
    
    console.log("\n✅ Deployment successful!");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📍 Proxy deployed to:", proxyAddress);
    console.log("📍 Implementation deployed to:", await upgrades.erc1967.getImplementationAddress(proxyAddress));
    console.log("📍 Admin deployed to:", await upgrades.erc1967.getAdminAddress(proxyAddress));
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    
    // Verificar el deployment
    const version = await proxy.version();
    console.log("📦 Contract version:", version.toString());
    console.log("👤 Owner:", await proxy.owner());
    
    console.log("\n💡 Important: Use the PROXY address for all interactions!");
    console.log("💡 Save this address:", proxyAddress);
    
    return {
        proxy: proxyAddress,
        implementation: await upgrades.erc1967.getImplementationAddress(proxyAddress)
    };
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });