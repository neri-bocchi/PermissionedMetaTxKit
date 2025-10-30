import hre from "hardhat";

const { ethers } = hre;

/**
 * Simple deployment script for RockPaperScissors contract
 *
 * This script deploys the contract directly without using meta-transactions.
 * Useful for local testing and development.
 *
 * Usage:
 *   npx hardhat run scripts/deployRockPaperScissorsSimple.js --network localhost
 *   npx hardhat run scripts/deployRockPaperScissorsSimple.js --network amoy
 */

async function main() {
  console.log("🎮 Deploying RockPaperScissors Contract (Simple Deployment)...\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log(`📡 Network: ${network.name} (chainId: ${network.chainId})`);
  console.log(`👤 Deployer: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`💰 Balance: ${ethers.formatEther(balance)} ETH\n`);

  // Deploy the contract
  console.log("📝 Deploying RockPaperScissors contract...");

  const RockPaperScissors = await ethers.getContractFactory("RockPaperScissors");

  // For simple deployment, we can use the deployer address as the trusted forwarder
  // In production, this should be the PermissionedMetaTxHub address
  const trustedForwarder = process.env.HUB_ADDRESS || deployer.address;

  console.log(`🔗 Trusted Forwarder: ${trustedForwarder}`);

  const rps = await RockPaperScissors.deploy(trustedForwarder);
  await rps.waitForDeployment();

  const address = await rps.getAddress();

  console.log("\n🎉 Deployment Successful!\n");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`📍 RockPaperScissors Address: ${address}`);
  console.log(`🔗 Trusted Forwarder: ${trustedForwarder}`);
  console.log(`👤 Owner/Deployer: ${deployer.address}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Example usage
  console.log("📋 Example Usage:");
  console.log("───────────────────────────────────────────────────────────");
  console.log("// Create a hashed move");
  console.log(`const hashedMove = await rps.hashMove(1, "mySecretSalt");`);
  console.log("");
  console.log("// Player 1 creates a game with 0.1 ETH wager");
  console.log(`await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, {`);
  console.log(`  value: ethers.parseEther("0.1")`);
  console.log(`});`);
  console.log("");
  console.log("// Player 2 joins the game");
  console.log(`await rps.connect(player2).joinGame(0, 2, { // 2 = PAPER`);
  console.log(`  value: ethers.parseEther("0.1")`);
  console.log(`});`);
  console.log("");
  console.log("// Player 1 reveals their move");
  console.log(`await rps.connect(player1).revealMove(0, 1, "mySecretSalt"); // 1 = ROCK`);
  console.log("");
  console.log("// Winner withdraws their prize");
  console.log(`await rps.connect(winner).withdrawAll();`);
  console.log("───────────────────────────────────────────────────────────\n");

  // Verify instructions
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("📋 To verify on block explorer:");
    console.log(`npx hardhat verify --network ${network.name} ${address} ${trustedForwarder}\n`);
  }

  return address;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
