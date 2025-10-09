const { ethers } = require("hardhat");

async function main() {
    console.log("Starting Storage contract deployment...");
    
    // Get the deployer account
    const [deployer] = await ethers.getSigners();
    console.log("Deploying with account:", deployer.address);
    
    // Get account balance
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Account balance:", ethers.formatEther(balance), "ETH");
    
    // Get the contract factory
    const Storage = await ethers.getContractFactory("Storage");
    
    console.log("Deploying Storage contract...");
    
    // Deploy the contract (no constructor parameters needed)
    const storage = await Storage.deploy();
    
    // Wait for deployment to be mined
    await storage.waitForDeployment();
    
    const contractAddress = await storage.getAddress();
    
    console.log("Storage deployed successfully!");
    console.log("Contract address:", contractAddress);
    console.log("Transaction hash:", storage.deploymentTransaction().hash);
    console.log("Owner address:", deployer.address);
    
    // Get network information
    const network = await ethers.provider.getNetwork();
    console.log("Network:", network.name, "(" + network.chainId + ")");
    
    // Log gas used
    const receipt = await storage.deploymentTransaction().wait();
    console.log("Gas used:", receipt.gasUsed.toString());
    
    // Test basic functionality
    console.log("\n🧪 Testing basic functionality...");
    
    // Store a number
    console.log("Storing number 42...");
    const storeTx = await storage.store(42);
    await storeTx.wait();
    console.log("Number stored successfully!");
    
    // Retrieve the number
    const retrievedNumber = await storage.retrieve();
    console.log("Retrieved number:", retrievedNumber.toString());
    
    // Test increment (owner only)
    console.log("Incrementing number...");
    const incrementTx = await storage.increment();
    await incrementTx.wait();
    
    const newNumber = await storage.retrieve();
    console.log("Number after increment:", newNumber.toString());
    
    // Verify contract on block explorer (if not on hardhat network)
    if (network.chainId !== 31337n) {
        console.log("\nTo verify the contract on the block explorer, run:");
        console.log(`npx hardhat verify --network ${network.name} ${contractAddress}`);
        
        // Save deployment info to file
        const deploymentInfo = {
            contractName: "Storage",
            address: contractAddress,
            network: network.name,
            chainId: network.chainId.toString(),
            txHash: storage.deploymentTransaction().hash,
            deployer: deployer.address,
            owner: deployer.address,
            timestamp: new Date().toISOString(),
            gasUsed: receipt.gasUsed.toString(),
            initialValue: "43" // After storing 42 and incrementing
        };
        
        const fs = require('fs');
        const path = require('path');
        
        const deploymentsDir = path.join(__dirname, '../deployments');
        if (!fs.existsSync(deploymentsDir)) {
            fs.mkdirSync(deploymentsDir, { recursive: true });
        }
        
        const deploymentFile = path.join(deploymentsDir, `Storage-${network.name}.json`);
        fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
        console.log("📁 Deployment info saved to:", deploymentFile);
    }
    
    console.log("\n Storage contract deployment completed successfully!");
    console.log("\n Contract Summary:");
    console.log("   • Address:", contractAddress);
    console.log("   • Owner:", deployer.address);
    console.log("   • Current stored value:", newNumber.toString());
    console.log("\n Available functions:");
    console.log("   • store(uint256) - Store a number (public)");
    console.log("   • retrieve() - Get stored number (view)");
    console.log("   • increment() - Increment by 1 (owner only)");
    console.log("   • reset() - Reset to 0 (owner only)");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Storage deployment failed:");
        console.error(error);
        process.exit(1);
    });