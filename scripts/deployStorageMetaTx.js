// deployStorageViaHub.js
import hre from "hardhat";
import "dotenv/config";
import { prepareForward, signForward, executeForward } from "../meta-exec-lib/src/index.js";

const { ethers } = hre;

const HUB_ADDRESS = process.env.HUB_ADDRESS;
const RELAYER_PK = process.env.RELAYER_PK;
const SENDER_PK = process.env.SENDER_PK;

async function main() {
  console.log("🚀 Deploying Storage via PermissionedMetaTxHub...\n");

  // 1️⃣ Wallets
  const provider = ethers.provider;
  const relayer = new ethers.Wallet(RELAYER_PK, provider);
  const sender = new ethers.Wallet(SENDER_PK, provider);

  console.log("Relayer (caller):", relayer.address);
  console.log("Sender (signer):", sender.address);
  console.log("Hub:", HUB_ADDRESS, "\n");

  // 2️⃣ Obtener bytecode de Storage (esto es el "callData" para CREATE)
  const StorageFactory = await ethers.getContractFactory("Storage");
  const deployBytecode = StorageFactory.bytecode;

  console.log("Storage bytecode length:", deployBytecode.length / 2 - 1, "bytes\n");

  // 3️⃣ Preparar Forward para CREATE (to = address(0))
  const space = 0;
  const nonce = Math.floor(Math.random() * 1000000);
  
  const { domain, types, message, fTuple, callData } = await prepareForward({
    provider,
    metaAddress: HUB_ADDRESS,
    hasCaller: true,
    from: sender.address,
    to: ethers.ZeroAddress, // ← CREATE deployment
    value: 0n,
    space,
    nonce,
    deadlineSec: 3600, // 1 hora
    callData: deployBytecode, // bytecode del contrato
    caller: relayer.address
  });

  console.log("📝 Forward prepared:");
  console.log("  - from:", message.from);
  console.log("  - to:", message.to, "(CREATE)");
  console.log("  - space:", message.space);
  console.log("  - nonce:", message.nonce.toString());
  console.log("  - caller:", message.caller);
  console.log();

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

  // 6️⃣ Encontrar dirección del contrato deployado
  const hub = await ethers.getContractAt("PermissionedMetaTxHub", HUB_ADDRESS);
  
  const deployEvent = receipt.logs
    .map((log) => {
      try {
        return hub.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "ContractDeployed");

  if (deployEvent) {
    const deployedAddress = deployEvent.args.deployed;
    console.log("🎉 Storage deployed at:", deployedAddress);

    // 7️⃣ Verificar que funciona
    const storage = await ethers.getContractAt("Storage", deployedAddress);
    const owner = await storage.owner();
    console.log("Storage owner:", owner);
    console.log("Owner matches sender?", owner.toLowerCase() === sender.address.toLowerCase());
  } else {
    console.log("⚠️  ContractDeployed event not found");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });