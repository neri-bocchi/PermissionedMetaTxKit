import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL is not set");
  const provider = new ethers.JsonRpcProvider(rpc);

  const owner = new ethers.Wallet(process.env.RELAYER_PK, provider);

  const argDeployer = process.argv[2];
  const argAllowed = process.argv[3];

  if (!argDeployer) {
    console.error("Usage: node scripts/setDeployer.js <deployerAddress> <true|false>");
    process.exit(1);
  }

  const deployer = ethers.getAddress(argDeployer);
  const allowed = argAllowed === "true" || argAllowed === "1";

  const metaAddr = ethers.getAddress(process.env.HUB_ADDRESS);
  const metaAbi = [
    "function setAllowedDeployer(address account, bool allowed) external",
    "function allowedDeployers(address) view returns (bool)",
    "function owner() view returns (address)"
  ];

  const meta = new ethers.Contract(metaAddr, metaAbi, owner);

  console.log("Owner (sender)       :", owner.address);
  console.log("Target deployer      :", deployer);
  console.log("Set allowed to       :", allowed);
  console.log("Hub address          :", metaAddr);

  const contractOwner = await meta.owner();
  if (contractOwner.toLowerCase() !== owner.address.toLowerCase()) {
    console.error("ERROR: You are not the owner");
    process.exit(1);
  }

  
  const current = await meta.allowedDeployers(deployer);
  console.log("Current status       :", current);

  if (current === allowed) {
    console.log("No change needed.");
    return;
  }

  console.log("Setting deployer status...");
  
const pendingNonce = await provider.getTransactionCount(
  owner.address,
  "pending" // incluye txs pendientes en mempool
);

// Obtener el nonce confirmado (solo txs minadas)
const confirmedNonce = await provider.getTransactionCount(
  owner.address,
  "latest"
);

console.log(`Nonce pendiente: ${pendingNonce}`);
console.log(`Nonce confirmado: ${confirmedNonce}`);
console.log(`Transacciones pendientes: ${pendingNonce - confirmedNonce}`);

  const tx = await meta.setAllowedDeployer(deployer, allowed,{gasPrice:0, gasLimit:4_000_000, type: 0 });
  console.log("tx:", tx.hash);
  await tx.wait();

  const after = await meta.allowedDeployers(deployer);
  console.log("Updated status       :", after);
  console.log("✅ Done");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
