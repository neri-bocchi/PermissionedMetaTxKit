import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL;
const RELAYER_PK = process.env.RELAYER_PK;
const HUB_ADDRESS = process.env.HUB_ADDRESS;

async function main() {
  console.log("=== Starting allowCaller script ===");
  
  const [,, callerAddress, ...flags] = process.argv;
  const useLatestNonce = flags.includes("--use-latest");
  
  console.log("Caller address from arguments:", callerAddress);
  
  if (!callerAddress || !ethers.isAddress(callerAddress)) {
    console.error("❌ Invalid caller address provided");
    console.error("Usage: node scripts/allowCaller.js <callerAddress> [--use-latest]");
    console.error("  --use-latest: Force use of latest nonce (replace pending tx)");
    process.exit(1);
  }
  console.log("✓ Caller address is valid");
  
  if (!RPC_URL || !RELAYER_PK || !HUB_ADDRESS) {
    console.error("❌ Missing RPC_URL, RELAYER_PK, or HUB_ADDRESS in .env");
    process.exit(1);
  }
  console.log("✓ Environment variables loaded");
  console.log("Network:", process.env.NETWORK || "default");
  console.log("RPC URL:", RPC_URL);
  console.log("Hub Address:", HUB_ADDRESS);

  console.log("\n--- Connecting to provider ---");
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  console.log("Connected to network:", network.name, "Chain ID:", network.chainId.toString());
  
  console.log("\n--- Setting up wallet ---");
  const owner = new ethers.Wallet(RELAYER_PK, provider);
  console.log("Owner address:", owner.address);
  
  const balance = await provider.getBalance(owner.address);
  console.log("Owner balance:", ethers.formatEther(balance), "ETH");
  
  // Check current nonce
  const currentNonce = await provider.getTransactionCount(owner.address, "latest");
  const pendingNonce = await provider.getTransactionCount(owner.address, "pending");
  console.log("Current nonce (latest):", currentNonce);
  console.log("Pending nonce:", pendingNonce);
  
  let selectedNonce;
  if (currentNonce !== pendingNonce) {
    const pendingCount = pendingNonce - currentNonce;
    console.warn(`⚠️  Warning: There are ${pendingCount} pending transaction(s)`);
    console.warn("   Nonces:", currentNonce, "to", pendingNonce - 1);
    
    if (useLatestNonce) {
      console.log("⚠️  --use-latest flag detected: Will attempt to replace transaction at nonce", currentNonce);
      console.log("⚠️  This requires a higher gas price than the pending transaction");
      selectedNonce = currentNonce;
    } else {
      console.log("ℹ️  Using pending nonce to queue after pending transactions");
      selectedNonce = pendingNonce;
    }
  } else {
    selectedNonce = currentNonce;
  }
  
  console.log("Selected nonce:", selectedNonce);

  console.log("\n--- Setting up contract ---");
  const abi = [
    "function setCallerAllowed(address caller, bool allowed) external"
  ];
  const hub = new ethers.Contract(HUB_ADDRESS, abi, owner);
  console.log("Hub contract initialized at:", HUB_ADDRESS);
  
  console.log("\n--- Preparing transaction ---");
  let tx = null;
  let txOptions = {};
  
  if (process.env.NETWORK === "LNET") {

    txOptions = { 
      gasPrice: 0, 
      type: 0,
      gasLimit: 5_000_000n,
      nonce: currentNonce
    };

     console.log("lnet using:",txOptions);   
  } else {
    console.log("Using default transaction settings");
    txOptions = {
      nonce: selectedNonce
    };
  }
  
  console.log("Setting caller allowed:", callerAddress);
  console.log("Transaction options:", txOptions);
  
  console.log("\n--- Sending transaction ---");
  tx = await hub.setCallerAllowed(callerAddress, true, txOptions);
  
  console.log("✓ Transaction sent!");
  console.log("Tx hash:", tx.hash);
  console.log("From:", tx.from);
  console.log("To:", tx.to);
  console.log("Nonce:", tx.nonce);
  
  if (selectedNonce === pendingNonce && pendingNonce > currentNonce) {
    console.log("\nℹ️  This transaction is queued after", pendingNonce - currentNonce, "pending transaction(s)");
    console.log("ℹ️  It will be mined after those complete");
  }
  
  console.log("\n--- Waiting for confirmation ---");
  const receipt = await tx.wait();
  
  console.log("✓ Transaction confirmed!");
  console.log("Block number:", receipt.blockNumber);
  console.log("Block hash:", receipt.blockHash);
  console.log("Gas used:", receipt.gasUsed.toString());
  console.log("Status:", receipt.status === 1 ? "Success" : "Failed");
  
  console.log("\n=== ✓ Caller allowed successfully ===");
  console.log("Caller address:", callerAddress);
  console.log("Hub address:", HUB_ADDRESS);
}

main().catch(e => {
  console.error("\n❌ Error occurred:");
  console.error(e);
  if (e.reason) console.error("Reason:", e.reason);
  if (e.code) console.error("Error code:", e.code);
  if (e.error && e.error.message) console.error("RPC Error:", e.error.message);
  process.exit(1);
});