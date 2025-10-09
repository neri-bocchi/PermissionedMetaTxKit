import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL;
const RELAYER_PK = process.env.RELAYER_PK; // Usamos RELAYER_PK como owner
const HUB_ADDRESS = process.env.HUB_ADDRESS;

async function main() {
  const [,, callerAddress] = process.argv;
  if (!callerAddress || !ethers.isAddress(callerAddress)) {
    console.error("Usage: node scripts/allowCaller.js <callerAddress>");
    process.exit(1);
  }
  if (!RPC_URL || !RELAYER_PK || !HUB_ADDRESS) {
    console.error("Missing RPC_URL, RELAYER_PK, or HUB_ADDRESS in .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const owner = new ethers.Wallet(RELAYER_PK, provider);

  // ABI mínima para setCallerAllowed
  const abi = [
    "function setCallerAllowed(address caller, bool allowed) external"
  ];
  const hub = new ethers.Contract(HUB_ADDRESS, abi, owner);

  const tx = await hub.setCallerAllowed(callerAddress, true);
  console.log("Tx sent:", tx.hash);
  await tx.wait();
  console.log("Caller allowed:", callerAddress);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});