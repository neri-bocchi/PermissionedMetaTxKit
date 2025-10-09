import pkg from 'hardhat';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import fs from 'fs';
import path from 'path';
const { ethers } = pkg;

async function main() {
    console.log("Starting MetaExecutor deployment...");
    
    // Get the deployer account
    const [deployer] = await ethers.getSigners();
    console.log("Deploying with account:", deployer.address);
    
    // Get account balance
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Account balance:", ethers.formatEther(balance), "ETH");
    
    // Get the contract factory
    const MetaExecutor = await ethers.getContractFactory("MetaExecutorV1_0");
    
    console.log("Deploying MetaExecutor contract...");
    
    // Deploy the contract (no constructor parameters needed)
    const metaExecutor = await MetaExecutor.deploy();
    
    // Wait for deployment to be mined
    await metaExecutor.waitForDeployment();
    
    const contractAddress = await metaExecutor.getAddress();
    
    console.log("✅ MetaExecutor deployed successfully!");
    console.log("📋 Contract address:", contractAddress);
    console.log("🔗 Transaction hash:", metaExecutor.deploymentTransaction().hash);
    
    // Get network information
    const network = await ethers.provider.getNetwork();
    console.log("🌐 Network:", network.name, "(" + network.chainId + ")");
    
    // Log gas used
    const receipt = await metaExecutor.deploymentTransaction().wait();
    console.log("⛽ Gas used:", receipt.gasUsed.toString());
    
    // Verify contract on block explorer (if not on hardhat network)
    if (network.chainId !== 31337n) {
        console.log("\n📝 To verify the contract on the block explorer, run:");
        console.log(`npx hardhat verify --network ${network.name} ${contractAddress}`);
        
        // Save deployment info to file
        const deploymentInfo = {
            contractName: "MetaExecutor",
            address: contractAddress,
            network: network.name,
            chainId: network.chainId.toString(),
            txHash: metaExecutor.deploymentTransaction().hash,
            deployer: deployer.address,
            timestamp: new Date().toISOString(),
            gasUsed: receipt.gasUsed.toString()
        };
        
        const deploymentsDir = path.join(__dirname, '../deployments');
        if (!fs.existsSync(deploymentsDir)) {
            fs.mkdirSync(deploymentsDir, { recursive: true });
        }
        
        const deploymentFile = path.join(deploymentsDir, `MetaExecutor-${network.name}.json`);
        fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
        console.log("📁 Deployment info saved to:", deploymentFile);
    }
    
    console.log("\n🎉 Deployment completed successfully!");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:");
        console.error(error);
        process.exit(1);
    });