// ============================================
// 1. checkDeployerStatus.js
// ============================================
import { ethers } from "ethers";
import "dotenv/config";

// Usage: node scripts/checkDeployerStatus.js [deployerAddress]
async function checkDeployerStatus() {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL is not set");
  const provider = new ethers.JsonRpcProvider(rpc);

  const argDeployer = process.argv[2];
  if (!argDeployer) {
    console.error("Usage: node scripts/checkDeployerStatus.js <deployerAddress>");
    process.exit(1);
  }
  const deployer = ethers.getAddress(argDeployer);

  const metaAddr = ethers.getAddress(process.env.HUB_ADDRESS);
  const metaAbi = [
    "function allowedDeployers(address) view returns (bool)",
    "function deployGasWindowState(address from) view returns (uint256 used, uint256 limit, uint64 startedAt, uint64 duration, uint256 nowTs)",
    "function getLastDeployBlock(address from) view returns (uint256)"
  ];

  const meta = new ethers.Contract(metaAddr, metaAbi, provider);

  console.log("Deployer address     :", deployer);
  console.log("Hub address          :", metaAddr);
  console.log("Current block        :", await provider.getBlockNumber());

  const isAllowed = await meta.allowedDeployers(deployer);
  console.log("\nIs allowed to deploy :", isAllowed);

  const [used, limit, startedAt, duration, nowTs] = await meta.deployGasWindowState(deployer);
  const lastBlock = await meta.getLastDeployBlock(deployer);

  console.log("\n--- Deploy Gas Window ---");
  console.log("Gas used in window   :", used.toString());
  console.log("Gas limit            :", limit.toString());
  console.log("Window started at    :", startedAt.toString(), `(${new Date(Number(startedAt) * 1000).toISOString()})`);
  console.log("Window duration      :", duration.toString(), "seconds");
  console.log("Current timestamp    :", nowTs.toString());
  console.log("Last deploy block    :", lastBlock.toString());

  if (limit > 0n && duration > 0n) {
    const remaining = limit - used;
    const percentUsed = (Number(used) / Number(limit) * 100).toFixed(2);
    console.log("\nRemaining gas        :", remaining.toString());
    console.log("Percentage used      :", percentUsed + "%");
  }
}