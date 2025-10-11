import hre from "hardhat";
import "dotenv/config";
import { 
  prepareForward, 
  signForward, 
  executeForward,
  getDeployedAddress 
} from "../meta-exec-lib/src/index.js";
import { META_ABI } from "../meta-exec-lib/src/abis.js";

const { ethers } = hre;

const HUB_ADDRESS = process.env.HUB_ADDRESS;   //PermissionedMetaTxHub contract address
const RELAYER_PK = process.env.RELAYER_PK;     //Relayer private key (must be in the PermissionedMetaTxHub allowlist)
const SENDER_PK = process.env.SENDER_PK;       //User private key (can be any EOA, not necessarily in the allowlist)

async function main() {
  console.log("🚀 Deploying Storage via PermissionedMetaTxHub...\n");

  // 1️⃣ Wallets
  const provider = ethers.provider;
  const relayer = new ethers.Wallet(RELAYER_PK, provider);
  const sender = new ethers.Wallet(SENDER_PK, provider);

  console.log("Relayer (caller):", relayer.address);
  console.log("Sender (signer):", sender.address);
  console.log("Hub:", HUB_ADDRESS, "\n");

  // 2️⃣ Obtener bytecode de Storage
  const StorageFactory = await ethers.getContractFactory("Storage");
  const deployBytecode = StorageFactory.bytecode;

  // 3️⃣ Preparar Forward para CREATE
  const space = 0;
  const nonce = Math.floor(Math.random() * 1000000);
  
  const { domain, types, message, fTuple, callData } = await prepareForward({
    provider,
    metaAddress: HUB_ADDRESS,
    hasCaller: true,
    from: sender.address,
    to: ethers.ZeroAddress,
    value: 0n,
    space,
    nonce,
    deadlineSec: 3600,
    callData: deployBytecode,
    caller: relayer.address
  });

  console.log("📋 Forward prepared");
//  console.log("  - from:", message.from);              //uncomment to see full details
//  console.log("  - to:", message.to, "(CREATE)");      //uncomment to see full details
//  console.log("  - space:", message.space);            //uncomment to see full details
//  console.log("  - nonce:", message.nonce.toString()); //uncomment to see full details
//  console.log("  - caller:", message.caller);          //uncomment to see full details
//  console.log();

  // 4️⃣ Firmar
  const signature = await signForward(sender, domain, types, message);
  console.log("✍️  Signature:", signature, "\n");

  // 5️⃣ Ejecutar
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
      value: 0n
    }
  });

  console.log("Tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("✅ Tx mined in block:", receipt.blockNumber, "\n");

  // 6️⃣ Obtener dirección del contrato deployado
  const deployedAddress = getDeployedAddress(receipt, META_ABI);

  if (deployedAddress) {
    console.log("🎉 Storage deployed at:", deployedAddress);
   } else {
    console.log("⚠️  Could not find deployed address in the receipt.");
  } 
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });