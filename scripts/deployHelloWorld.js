// scripts/deployMetaTxForwarder.js
import hre from "hardhat";
import fs from "fs";

async function main() {
  const FQN = process.env.FQN || "contracts/HelloWorld.sol:HelloWorld";
  const [deployer] = await hre.ethers.getSigners();
  const { _gasPrice, _chainId , _type } = hre.network.config;

  console.log("Starting HelloWorld deployment...");
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  // Usa FQN explícito
  const HubFactory = await hre.ethers.getContractFactory(FQN);
  const artifact = await hre.artifacts.readArtifact(FQN);

  // Loguea hash de runtime que VAS a desplegar (sin metadata)
  const runtime = artifact.deployedBytecode; // ya es runtime
  console.log("local runtime size:", runtime.length / 2 - 1, "bytes");
  console.log("local runtime keccak:", hre.ethers.keccak256(runtime));

  if (process.env.NETWORK==="LNET")  {  
    var hub = await HubFactory.deploy({
      type: 0,
      gasprice: 0,
      gasLimit: 30_000_000,
  })
  }
  else {
    console.log("Deploying without custom tx parameters...");
    var hub =  await HubFactory.deploy();
  }
  console.log("Deployment transaction sent. Waiting for confirmation...");  
  const tx = hub.deploymentTransaction();
  console.log("tx hash:", tx.hash);
  await hub.waitForDeployment();
  console.log("Contract deployed!");

  const addr = await hub.getAddress();
  const receipt = await hre.ethers.provider.getTransactionReceipt(tx.hash);

  console.log("✅ MetaTxForwarder deployed successfully!");
  console.log("📋 Contract address:", addr);
  console.log("🔗 Deployment tx hash:", tx.hash);
  console.log("🌐 Network:", hre.network.name);
  console.log("⛽ Gas used:", receipt.gasUsed.toString());

  // Guarda info mínima
  fs.mkdirSync("./deployments", { recursive: true });
  fs.writeFileSync(
    "./deployments/HelloWorld-amoy.json",
    JSON.stringify({ address: addr, txHash: tx.hash, network: hre.network.name }, null, 2)
  );

  console.log("🎉 Deployment completed successfully!");
}

main().catch((e) => { console.error(e); process.exit(1); });
