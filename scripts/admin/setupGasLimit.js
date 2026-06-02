import { ethers } from "ethers";
import "dotenv/config";

// Usage:
//   node scripts/setupGasLimit.js [callerAddress] [limit]
// Examples:
//   node scripts/setupGasLimit.js 0xabc... 1000000
//   node scripts/setupGasLimit.js                       # defaults: caller = PRIVATE_KEY address, limit = 0 (no limit)

async function main() {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL is not set in .env");
  const provider = new ethers.JsonRpcProvider(rpc);

  // Owner wallet (must be the contract owner)
  const owner = new ethers.Wallet(process.env.RELAYER_PK, provider);

  // Params: caller address and limit
  const argCaller = process.argv[2];
  const argLimit = process.argv[3];

  const caller = ethers.getAddress(argCaller ?? owner.address);
  const limit = argLimit ? BigInt(argLimit) : 0n; // 0 = no limit

  // PermissionedMetaTxHub address (update here if needed)
  const metaAddr = ethers.getAddress(process.env.HUB_ADDRESS);

  const metaAbi = [
    "function setGasLimitPerBlock(address caller, uint256 limit) external",
    "function gasLimitPerBlock(address caller) view returns (uint256)",
    "function owner() view returns (address)"
  ];

  const meta = new ethers.Contract(metaAddr, metaAbi, owner);

  console.log("Owner (sender)         :", owner.address);
  console.log("Target caller          :", caller);
  console.log("New limit              :", limit.toString());
  console.log("PermissionedMetaTxHub  :", metaAddr);

  // Verify ownership
  const contractOwner = await meta.owner();
  if (contractOwner.toLowerCase() !== owner.address.toLowerCase()) {
    console.error("ERROR: You are not the owner of this contract.");
    console.error(`Contract owner: ${contractOwner}`);
    console.error(`Your address  : ${owner.address}`);
    process.exit(1);
  }

  // Show current limit
  const current = await meta.gasLimitPerBlock(caller);
  console.log("Current limit :", current.toString());

  // If unchanged, exit early
  if (current === limit) {
    console.log("No change needed. Limit already set to this value.");
    return;
  }

  console.log("Setting gas limit per block...");
  var txOptions = {}; 
  if (process.env.NETWORK === "LNET") {
  txOptions = { 
      gasPrice: 0, 
      type: 0,
      gasLimit: 4_000_000}
  }
  
  const tx = await meta.setGasLimitPerBlock(caller, limit, txOptions);
  console.log("tx:", tx.hash);
  await tx.wait();

  const after = await meta.gasLimitPerBlock(caller);
  console.log("Updated limit :", after.toString());
  console.log("✅ Done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
