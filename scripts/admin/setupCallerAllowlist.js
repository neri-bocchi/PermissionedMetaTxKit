import { ethers } from "ethers";
import "dotenv/config";
import env from "hardhat";

async function main() {
  const rpc = process.env.RPC_URL;
  const provider = new ethers.JsonRpcProvider(rpc);

const address_to_allow = process.argv[2];
  // Load the owner wallet (must be the deployer/owner of the contract)
  const owner = new ethers.Wallet(process.env.RELAYER_PK, provider);

   const relayer = new ethers.Wallet(process.env.RELAYER_PK, provider);

  // Address of the relayer that will be added to the caller allowlist
  //const relayerAddress = owner.address; // In this example, using the same wallet

  // PermissionedMetaTxHub contract address and ABI
  const hubContractAddress = ethers.getAddress(process.env.HUB_ADDRESS);
  const hubAbi = [
    "function setCallerAllowed(address caller, bool allowed) external",
    "function isCallerAllowed(address) view returns (bool)",
  ];

  // Initialize contract instance
  const hub = new ethers.Contract(hubContractAddress, hubAbi, relayer);

  console.log("Owner address:", relayer.address);
  console.log("Relayer address to allowlist:", address_to_allow);
  console.log("PermissionedMetaTxHub contract address:", hubContractAddress);

  try {



    // Check if the relayer is already in the allowlist
    const isAllowed = await hub.isCallerAllowed(address_to_allow);
    console.log(`Is relayer currently allowed: ${isAllowed}`);

    if (isAllowed) {
      console.log("✅ Relayer is already in the allowlist. No action required.");
      return;
    }

    // Add relayer to the caller allowlist
    console.log("Adding relayer to caller allowlist...");
    const tx = await hub.setCallerAllowed(address_to_allow, true);
    console.log("Transaction hash:", tx.hash);

    // Wait for the transaction confirmation
    await tx.wait();
    console.log("✅ Relayer successfully added to caller allowlist!");

    // Double-check allowlist status
    const isNowAllowed = await hub.isCallerAllowed(address_to_allow);
    console.log(`Verification - Is relayer now allowed: ${isNowAllowed}`);

  } catch (error) {
    console.error("❌ Error during allowlist update:");
    console.error(error.message);
    process.exit(1);
  }
}

// Entry point
main().catch((error) => {
  console.error("Unhandled error:");
  console.error(error);
  process.exit(1);
});