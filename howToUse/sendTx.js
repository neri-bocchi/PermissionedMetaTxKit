import { ethers } from "ethers";
import { buildCallData, prepareForward, signForward, executeForward } from "../meta-exec-lib/src/index.js";
import "dotenv/config";

const HUB_ADDRESS = process.env.HUB_ADDRESS;
const STORAGE_ADDRESS = "0x98F6431E1CcdEc19087e3cE497275B2296fE46E7";

async function main() {
  // Setup
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const user = new ethers.Wallet(process.env.SENDER_PK, provider);
  const relayer = new ethers.Wallet(process.env.RELAYER_PK, provider);

  // Preparar datos
  const valueToStore = Math.floor(Math.random() * 1000);
  const callData = buildCallData(["function store(uint256)"], "store", [valueToStore]);

  const space = 1500;
  const nonce = Math.floor(Math.random() * 1000000);

  console.log(`📝 Storing value: ${valueToStore}`);
  console.log(`🔢 Using nonce: ${nonce}\n`);

  // Preparar meta-tx
  const prep = await prepareForward({
    provider,
    metaAddress: HUB_ADDRESS,
    domainName: "PermissionedMetaTxHub",
    domainVersion: "1",
    hasCaller: true,
    from: user.address,
    to: STORAGE_ADDRESS,
    callData,
    caller: relayer.address,
    value: 0n,
    space,
    nonce,
    deadlineSec: 24 * 60 * 60 // 24 horas
  });

  // Firmar
  const signature = await signForward(user, prep.domain, prep.types, prep.message);

  // Ejecutar
  console.log("📡 Sending meta-tx...");
  const tx = await executeForward({
    provider,
    metaAddress: HUB_ADDRESS,
    fTuple: prep.fTuple,
    callData: prep.callData,
    signature,
    relayer,
    hasCaller: true
  });

  console.log("Tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log(`✅ Mined in block ${receipt.blockNumber}\n`);
  console.log(`🎉 Store executed successfully!`);
}

main().catch(console.error);