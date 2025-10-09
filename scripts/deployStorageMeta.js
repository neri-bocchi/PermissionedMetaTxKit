import hre from "hardhat";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  console.log("Starting Storage deployment...");

  // Usa la clave privada del deployer desde .env
  const deployer = new hre.ethers.Wallet(process.env.RELAYER_PK, hre.ethers.provider);
  console.log("Deploying with account:", deployer.address);

  // Muestra el balance
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", hre.ethers.formatEther(balance), "ETH");

  // Obtiene el factory del contrato Storage
  const StorageFactory = await hre.ethers.getContractFactory("Storage", deployer);

  // Si el contrato tuviera argumentos, podrías leerlos de process.env.STORE_ARGS
  // Pero en este caso no tiene constructor con argumentos
  console.log("Deploying Storage...");
  const storage = await StorageFactory.deploy();

  await storage.waitForDeployment();
  const contractAddress = await storage.getAddress();

  console.log("✅ Storage deployed successfully!");
  console.log("📋 Contract address:", contractAddress);
  console.log("🔗 Deployment tx hash:", storage.deploymentTransaction().hash);

  // Info de red
  const network = await hre.ethers.provider.getNetwork();
  console.log("🌐 Network:", network.name, "(" + network.chainId + ")");

  // Gas usado
  const receipt = await storage.deploymentTransaction().wait();
  console.log("⛽ Gas used:", receipt.gasUsed.toString());

  // Guarda metadata de deploy
  const deploymentInfo = {
    contractName: "Storage",
    address: contractAddress,
    network: network.name,
    chainId: network.chainId.toString(),
    txHash: storage.deploymentTransaction().hash,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    gasUsed: receipt.gasUsed.toString(),
  };

  if (!fs.existsSync("./deployments")) {
    fs.mkdirSync("./deployments");
  }
  fs.writeFileSync(
    `./deployments/Storage-${network.name}.json`,
    JSON.stringify(deploymentInfo, null, 2)
  );
  console.log("📁 Deployment info saved to:", `./deployments/Storage-${network.name}.json`);
  console.log("\n🎉 Deployment completed successfully!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:");
    console.error(error);
    process.exit(1);
  });