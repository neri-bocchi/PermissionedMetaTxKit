import hre from "hardhat";
const { ethers } = hre;
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  console.log("Starting PermissionedMetaTxHub deployment...");

  // Deployer (EOA) that will own the contract
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // Show current balance for visibility
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH");

  // Load the contract factory (must match the Solidity contract name)
  const HubFactory = await ethers.getContractFactory("PermissionedMetaTxHub");

  console.log("Deploying PermissionedMetaTxHub...");

  // Deploy the contract (no constructor arguments required)
  const hub = await HubFactory.deploy();

  // Wait until the deployment is mined and address is assigned
  await hub.waitForDeployment();

  const contractAddress = await hub.getAddress();

  console.log("✅ PermissionedMetaTxHub deployed successfully!");
  console.log("📋 Contract address:", contractAddress);
  console.log("🔗 Deployment tx hash:", hub.deploymentTransaction().hash);

  // Network info for logs and verification hint
  const network = await ethers.provider.getNetwork();
  console.log("🌐 Network:", network.name, "(" + network.chainId + ")");

  // Gas used on deployment (from receipt)
  const receipt = await hub.deploymentTransaction({gasLimit: sfsfd}).wait();
  console.log("⛽ Gas used:", receipt.gasUsed.toString());

  // Optionally print a verification command and persist metadata
  if (network.chainId !== 31337n) {
    console.log("\n📝 To verify the contract on the block explorer, run:");
    console.log(`npx hardhat verify --network ${network.name} ${contractAddress}`);

    // Persist minimal deployment metadata for future tooling
    const deploymentInfo = {
      contractName: "PermissionedMetaTxHub",
      address: contractAddress,
      network: network.name,
      chainId: network.chainId.toString(),
      txHash: hub.deploymentTransaction().hash,
      deployer: deployer.address,
      timestamp: new Date().toISOString(),
      gasUsed: receipt.gasUsed.toString(),
    };

    const deploymentsDir = path.join(__dirname, "../deployments");
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const deploymentFile = path.join(
      deploymentsDir,
      `PermissionedMetaTxHub-${network.name}.json`
    );
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