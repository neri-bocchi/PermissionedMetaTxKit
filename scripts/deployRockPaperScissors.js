import hre from "hardhat";
import { prepareForward, signForward, executeForward } from "../meta-exec-lib/src/index.js";
import hubAbi from "../meta-exec-lib/src/abis.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { ethers } = hre;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Deploy RockPaperScissors contract using meta-transaction
 *
 * This script deploys the RockPaperScissors contract via the PermissionedMetaTxHub,
 * enabling gasless deployment where the relayer pays for gas.
 *
 * Prerequisites:
 * 1. Set RELAYER_PK in .env (relayer must be in hub's allowlist)
 * 2. Set SENDER_PK in .env (actual deployer/owner)
 * 3. Set HUB_ADDRESS in .env (PermissionedMetaTxHub address)
 *
 * Usage:
 *   npx hardhat run scripts/deployRockPaperScissors.js --network amoy
 */

/**
 * Helper function to extract deployed address from CREATE transaction
 */
function getDeployedAddress(receipt, metaAbi) {
  for (const log of receipt.logs) {
    try {
      const iface = new ethers.Interface(metaAbi);
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "Forwarded") {
        const success = parsed.args.success;
        const deployedAddr = parsed.args.result;
        if (success && deployedAddr !== ethers.ZeroAddress) {
          return deployedAddr;
        }
      }
    } catch (err) {
      continue;
    }
  }
  return null;
}

/**
 * Save deployment info to file
 */
function saveDeployment(network, contractAddress, deploymentData) {
  const deploymentsDir = path.join(__dirname, "../deployments");
  const networkDir = path.join(deploymentsDir, network);

  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir);
  }
  if (!fs.existsSync(networkDir)) {
    fs.mkdirSync(networkDir);
  }

  const filePath = path.join(networkDir, "RockPaperScissors.json");
  fs.writeFileSync(filePath, JSON.stringify(deploymentData, null, 2));

  console.log(`\n✅ Deployment info saved to: ${filePath}`);
}

async function main() {
  console.log("🎮 Deploying RockPaperScissors Contract via Meta-Transaction...\n");

  // Load environment variables
  const HUB_ADDRESS = process.env.HUB_ADDRESS;
  const RELAYER_PK = process.env.RELAYER_PK;
  const SENDER_PK = process.env.SENDER_PK;

  if (!HUB_ADDRESS || !RELAYER_PK || !SENDER_PK) {
    throw new Error(
      "Missing required environment variables: HUB_ADDRESS, RELAYER_PK, SENDER_PK"
    );
  }

  const provider = ethers.provider;
  const network = await provider.getNetwork();

  console.log(`📡 Network: ${network.name} (chainId: ${network.chainId})`);
  console.log(`🔗 Hub Address: ${HUB_ADDRESS}\n`);

  // Initialize wallets
  const relayer = new ethers.Wallet(RELAYER_PK, provider);
  const sender = new ethers.Wallet(SENDER_PK, provider);

  console.log(`👤 Relayer: ${relayer.address}`);
  console.log(`👤 Sender (Owner): ${sender.address}\n`);

  // Check balances
  const relayerBalance = await provider.getBalance(relayer.address);
  const senderBalance = await provider.getBalance(sender.address);

  console.log(`💰 Relayer Balance: ${ethers.formatEther(relayerBalance)} ETH`);
  console.log(`💰 Sender Balance: ${ethers.formatEther(senderBalance)} ETH\n`);

  if (relayerBalance < ethers.parseEther("0.01")) {
    console.warn("⚠️  Warning: Relayer balance is low!\n");
  }

  // Get contract factory and bytecode
  console.log("📝 Compiling contract...");
  const RockPaperScissors = await ethers.getContractFactory("RockPaperScissors");

  // Encode constructor arguments: (address trustedForwarder)
  // The trusted forwarder is the PermissionedMetaTxHub
  console.log("🔧 Encoding constructor arguments...");
  const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address"],
    [HUB_ADDRESS]
  );

  const deployBytecode = RockPaperScissors.bytecode + constructorArgs.slice(2);
  console.log(`📦 Bytecode size: ${deployBytecode.length / 2} bytes\n`);

  // Prepare meta-transaction
  console.log("🔐 Preparing meta-transaction...");
  const nonce = Math.floor(Math.random() * 1_000_000);

  const { domain, types, message, fTuple, callData } = await prepareForward({
    provider,
    metaAddress: HUB_ADDRESS,
    hasCaller: true,
    from: sender.address,
    to: ethers.ZeroAddress, // CREATE deployment (to = 0x0)
    value: 0n,
    space: 0,
    nonce: nonce,
    deadlineSec: 3600, // 1 hour deadline
    callData: deployBytecode,
    caller: relayer.address,
  });

  console.log(`  ✓ Nonce: ${nonce}`);
  console.log(`  ✓ Deadline: ${message.deadline}`);
  console.log(`  ✓ Domain: ${domain.name}\n`);

  // Sign the meta-transaction
  console.log("✍️  Signing meta-transaction...");
  const signature = await signForward(sender, domain, types, message);
  console.log(`  ✓ Signature: ${signature.slice(0, 20)}...${signature.slice(-10)}\n`);

  // Execute meta-transaction
  console.log("🚀 Executing meta-transaction...");
  console.log("⏳ Waiting for transaction confirmation...\n");

  const tx = await executeForward({
    provider,
    metaAddress: HUB_ADDRESS,
    fTuple,
    callData,
    signature,
    relayer,
    hasCaller: true,
    checkAllowlist: true,
    overrides: {
      gasLimit: 3_000_000, // Increased gas limit for deployment
    },
  });

  console.log(`📝 Transaction Hash: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}\n`);

  // Extract deployed address
  const deployedAddress = getDeployedAddress(receipt, hubAbi.META_ABI);

  if (!deployedAddress) {
    throw new Error("Failed to extract deployed contract address from receipt");
  }

  console.log("🎉 Deployment Successful!\n");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`📍 RockPaperScissors Address: ${deployedAddress}`);
  console.log(`🔗 Trusted Forwarder: ${HUB_ADDRESS}`);
  console.log(`👤 Owner: ${sender.address}`);
  console.log(`⛽ Gas Used: ${receipt.gasUsed.toString()}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Save deployment information
  const deploymentData = {
    address: deployedAddress,
    trustedForwarder: HUB_ADDRESS,
    owner: sender.address,
    deployer: relayer.address,
    deployedAt: new Date().toISOString(),
    network: network.name,
    chainId: Number(network.chainId),
    transactionHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    constructorArgs: {
      trustedForwarder: HUB_ADDRESS,
    },
  };

  saveDeployment(network.name, deployedAddress, deploymentData);

  // Display next steps
  console.log("📋 Next Steps:");
  console.log("───────────────────────────────────────────────────────────");
  console.log("1. Verify contract on block explorer:");
  console.log(`   npx hardhat verify --network ${network.name} ${deployedAddress} ${HUB_ADDRESS}`);
  console.log("\n2. Test the contract:");
  console.log("   npx hardhat test test/RockPaperScissors.test.js");
  console.log("\n3. Interact with the contract:");
  console.log(`   const rps = await ethers.getContractAt("RockPaperScissors", "${deployedAddress}");`);
  console.log("   const hashedMove = await rps.hashMove(1, 'mySecret');");
  console.log("   await rps.createGame(hashedMove, ethers.ZeroAddress, { value: ethers.parseEther('0.1') });");
  console.log("───────────────────────────────────────────────────────────\n");

  return deployedAddress;
}

// Execute deployment
main()
  .then((address) => {
    console.log("✨ Deployment script completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Deployment failed:");
    console.error(error);
    process.exit(1);
  });
