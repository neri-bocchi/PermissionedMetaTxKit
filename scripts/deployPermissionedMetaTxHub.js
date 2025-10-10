// scripts/deployPermissionedMetaTxHub.js
import hre from "hardhat";
import fs from "fs";

async function main() {
  const FQN = process.env.FQN || "contracts/PermissionedMetaTxHub.sol:PermissionedMetaTxHub";
  const [deployer] = await hre.ethers.getSigners();

  console.log("Starting PermissionedMetaTxHub deployment...");
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  // Usa FQN explícito
  const HubFactory = await hre.ethers.getContractFactory(FQN);
  const artifact = await hre.artifacts.readArtifact(FQN);

  // Loguea hash de runtime que VAS a desplegar (sin metadata)
  const runtime = artifact.deployedBytecode; // ya es runtime
  console.log("local runtime size:", runtime.length / 2 - 1, "bytes");
  console.log("local runtime keccak:", hre.ethers.keccak256(runtime));

  const hub = await HubFactory.deploy();
  const tx = hub.deploymentTransaction();
  await hub.waitForDeployment();

  const addr = await hub.getAddress();
  const receipt = await hre.ethers.provider.getTransactionReceipt(tx.hash);

  console.log("✅ PermissionedMetaTxHub deployed successfully!");
  console.log("📋 Contract address:", addr);
  console.log("🔗 Deployment tx hash:", tx.hash);
  console.log("🌐 Network:", hre.network.name);
  console.log("⛽ Gas used:", receipt.gasUsed.toString());

  // Guarda info mínima
  fs.mkdirSync("./deployments", { recursive: true });
  fs.writeFileSync(
    "./deployments/PermissionedMetaTxHub-amoy.json",
    JSON.stringify({ address: addr, txHash: tx.hash, network: hre.network.name }, null, 2)
  );

  console.log("🎉 Deployment completed successfully!");
}

main().catch((e) => { console.error(e); process.exit(1); });