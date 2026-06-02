// scripts/deployMetaTxForwarder.js
import hre from "hardhat";
import fs from "fs";

async function main() {
  const FQN = process.env.FQN || "contracts/MetaTxForwarder.sol:MetaTxForwarder";
  const [deployer] = await hre.ethers.getSigners();
  const { _gasPrice, _chainId, _type } = hre.network.config;

  // Dirección objetivo
  const TARGET_ADDRESS = "0x9a49A9e7b5b07CDd6218624687D3C9FD30e853Bd";

  console.log("Starting MetaTxForwarder deployment with CREATE2...");
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());
  console.log("Target address:", TARGET_ADDRESS);

  const HubFactory = await hre.ethers.getContractFactory(FQN);
  const artifact = await hre.artifacts.readArtifact(FQN);
  const bytecode = artifact.bytecode;

  console.log("Bytecode size:", bytecode.length / 2 - 1, "bytes");
  console.log("Bytecode keccak:", hre.ethers.keccak256(bytecode));

  // Buscar el salt correcto
  console.log("\n🔍 Searching for correct salt...");
  let salt;
  let found = false;

  for (let i = 0; i < 1000000; i++) {
    const testSalt = hre.ethers.hexlify(hre.ethers.toBeHex(i, 32));
    const predictedAddr = hre.ethers.getCreate2Address(
      deployer.address,
      testSalt,
      hre.ethers.keccak256(bytecode)
    );

    if (predictedAddr.toLowerCase() === TARGET_ADDRESS.toLowerCase()) {
      salt = testSalt;
      found = true;
      console.log("✅ Salt found:", salt);
      console.log("   Salt decimal:", i);
      break;
    }

    if (i % 10000 === 0) {
      console.log(`   Tested ${i} salts...`);
    }
  }

  if (!found) {
    throw new Error("❌ Could not find salt for target address. The address might not be achievable from this deployer.");
  }

  // Desplegar con CREATE2
  console.log("\n📤 Deploying with CREATE2...");
  
  const deployTx = {
    data: bytecode,
    salt: salt,
  };

  if (_chainId === 648540 || _chainId === 648541) {
    deployTx.type = _type;
    deployTx.chainId = _chainId;
    deployTx.gasPrice = _gasPrice;
  }

  const hub = await HubFactory.getDeployTransaction();
  const factory = new hre.ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    deployer
  );

  const contract = await factory.deploy({ customData: { salt } });
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  const tx = contract.deploymentTransaction();
  const receipt = await hre.ethers.provider.getTransactionReceipt(tx.hash);

  console.log("\n✅ MetaTxForwarder deployed successfully!");
  console.log("📋 Contract address:", addr);
  console.log("🎯 Target address:", TARGET_ADDRESS);
  console.log("✓  Addresses match:", addr.toLowerCase() === TARGET_ADDRESS.toLowerCase());
  console.log("🔗 Deployment tx hash:", tx.hash);
  console.log("🌐 Network:", hre.network.name);
  console.log("⛽ Gas used:", receipt.gasUsed.toString());

  // Guardar info
  fs.mkdirSync("./deployments", { recursive: true });
  fs.writeFileSync(
    "./deployments/MetaTxForwarder-amoy.json",
    JSON.stringify({
      address: addr,
      targetAddress: TARGET_ADDRESS,
      salt: salt,
      txHash: tx.hash,
      network: hre.network.name
    }, null, 2)
  );

  console.log("🎉 Deployment completed successfully!");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});