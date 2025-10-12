// scripts/deployStorageMeta.js
import hre from "hardhat";
import "dotenv/config";
import {prepareForward,signForward,executeForward,getDeployedAddress,setLogging,hubAbi} from "../meta-exec-lib/src/index.js";

setLogging(false);

const { ethers } = hre;

const HUB_ADDRESS = process.env.HUB_ADDRESS;   // PermissionedMetaTxHub contract address
const RELAYER_PK = process.env.RELAYER_PK;     // Must be allowlisted in the Hub
const SENDER_PK = process.env.SENDER_PK;       // Initial owner (user's EOA)

async function main() {
  if (!HUB_ADDRESS || !RELAYER_PK || !SENDER_PK) {
    throw new Error("Faltan env vars: HUB_ADDRESS, RELAYER_PK, SENDER_PK");
  }

  console.log("🚀 Deploying Storage (EIP-2771) via PermissionedMetaTxHub...\n");

  // 1️⃣ Wallets
  const provider = ethers.provider;
  const relayer = new ethers.Wallet(RELAYER_PK, provider);
  const sender = new ethers.Wallet(SENDER_PK, provider);

  console.log("Relayer (caller):", relayer.address);
  console.log("Sender  (signer):", sender.address);
  console.log("Hub:", HUB_ADDRESS, "\n");

  // 2️⃣ Storage bytecode with 2 constructor args (forwarder, owner)
  const StorageFactory = await ethers.getContractFactory("Storage");

  // Encode constructor args: (trustedForwarder, contractOwner)
  const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address"],
    [HUB_ADDRESS, sender.address]
  );

  // Combine bytecode + constructor args
  const deployBytecode = StorageFactory.bytecode + constructorArgs.slice(2);

  console.log(
    "Storage bytecode length:",
    (deployBytecode.length - 2) / 2,
    "bytes"
  );
  console.log("Constructor args:");
  console.log("  trustedForwarder:", HUB_ADDRESS);
  console.log("  contractOwner:   ", sender.address);
  
  // 3️⃣ Prepare Forward for CREATE
  const space = 0;
  const nonce = Math.floor(Math.random() * 1_000_000);

  const { domain, types, message, fTuple, callData } = await prepareForward({
    provider,
    metaAddress: HUB_ADDRESS,
    hasCaller: true,
    from: sender.address,
    to: ethers.ZeroAddress, // CREATE deployment
    value: 0n,
    space,
    nonce,
    deadlineSec: 3600,
    callData: deployBytecode,
    caller: relayer.address,
  });

  console.log("📋 Forward prepared");
  // console.log("  - from:", message.from);
  // console.log("  - to:", message.to, "(CREATE)");
  // console.log("  - nonce:", message.nonce.toString());
  // console.log("  - caller:", message.caller);
  // console.log();

  // 4️⃣ Sign
  const signature = await signForward(sender, domain, types, message);
  console.log("✍️  Signature:", signature, "\n");

  // 5️⃣ Execute
  console.log("📡 Sending meta-tx to hub...");
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
      gasLimit: 3_000_000,
      value: 0n,
    },
  });

  console.log("Tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("✅ Tx mined in block:", receipt.blockNumber, "\n");

  // 6️⃣ Get deployed contract address
  const deployedAddress = getDeployedAddress(receipt, hubAbi.META_ABI);

  if (!deployedAddress) {
    console.log("⚠️  Could not find deployed address in the receipt.");
    return;
  }

  console.log("🎉 Storage deployed at:", deployedAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });