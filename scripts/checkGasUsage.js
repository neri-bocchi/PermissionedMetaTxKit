import { ethers } from "ethers";
import "dotenv/config";

// Usage:
//   node scripts/checkGasUsage.js [callerAddress]
// Example:
//   node scripts/checkGasUsage.js 0xabc...
//   node scripts/checkGasUsage.js                    # defaults to PRIVATE_KEY address

async function main() {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL is not set in .env");
  const provider = new ethers.JsonRpcProvider(rpc);

  // Get caller address from args or default to env wallet
  const argCaller = process.argv[2];
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const caller = ethers.getAddress(argCaller ?? wallet.address);

  // MetaExecutor address
  const metaAddr = ethers.getAddress("0x094815651AEe2CC0ea2445C34fc327323165025a");

  const metaAbi = [
    "function gasUsedThisBlock(address caller) view returns (uint256 used, uint256 limit, uint256 blockNo)",
    "function gasLimitPerBlock(address caller) view returns (uint256)",
    "function gasAccountingOverhead() view returns (uint256)"
  ];

  const meta = new ethers.Contract(metaAddr, metaAbi, provider);

  console.log("Caller address   :", caller);
  console.log("MetaExecutor     :", metaAddr);
  console.log("Current block    :", await provider.getBlockNumber());
  
  // Get gas usage info
  const [used, limit, blockNo] = await meta.gasUsedThisBlock(caller);
  const overhead = await meta.gasAccountingOverhead();

  console.log("\n--- Gas Usage Status ---");
  console.log("Gas used this block   :", used.toString());
  console.log("Gas limit per block   :", limit.toString(), limit === 0n ? "(unlimited)" : "");
  console.log("Last tracked block    :", blockNo.toString());
  console.log("Accounting overhead   :", overhead.toString());

  if (limit > 0n) {
    const remaining = limit - used;
    const percentUsed = (Number(used) / Number(limit) * 100).toFixed(2);
    
    console.log("\n--- Usage Summary ---");
    console.log("Remaining gas        :", remaining.toString());
    console.log("Percentage used      :", percentUsed + "%");
    
    if (used >= limit) {
      console.log("⚠️  WARNING: Gas limit reached! No more transactions allowed this block.");
    } else if (Number(percentUsed) > 80) {
      console.log("⚠️  WARNING: Gas usage is high (>80%)");
    } else {
      console.log("✅ Gas usage within acceptable range");
    }
  } else {
    console.log("\n✅ No gas limit set (unlimited)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});