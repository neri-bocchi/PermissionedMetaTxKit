import { ethers } from "ethers";
import { buildCallData, prepareForward, signForward, executeForward } from "../meta-exec-lib/src/index.js";
import "dotenv/config";
import fs from 'fs/promises';
import path from 'path';


const HUB_ADDRESS = process.env.HUB_ADDRESS;
const STORAGE_ADDRESS = "0x98F6431E1CcdEc19087e3cE497275B2296fE46E7"; // Update with your deployed Storage address


function generateNonceBitmap() {
  const timestamp = Math.floor(Date.now() / 1000);
  const random32 = crypto.getRandomValues(new Uint32Array(1))[0];
  const nonce = (BigInt(timestamp) << 32n) | BigInt(random32);
  return nonce; 
}

// Get or sync nonce from local cache or network
// this is not secure for produc
export async function getOrSyncNonce(provider, relayerAddress, cacheFile = './nonce.json') {
  let localNonce = null;
  let networkNonce = null;
  try {
    const data = await fs.readFile(cacheFile, 'utf8');
    const json = JSON.parse(data);
    if (json.address === relayerAddress) {
      localNonce = json.nonce;
    }
  } catch {
  }
  networkNonce = await provider.getTransactionCount(relayerAddress);
  const nonceToUse = localNonce !== null ? Math.max(localNonce, networkNonce) : networkNonce;
  await fs.writeFile(
    cacheFile,
    JSON.stringify({ address: relayerAddress, nonce: nonceToUse + 1 }, null, 2),
    'utf8'
  );
  return nonceToUse;
}

async function main() {
  // Setup
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const user = new ethers.Wallet(process.env.SENDER_PK, provider);
  const relayer = new ethers.Wallet(process.env.RELAYER_PK, provider);

  // Preparar datos
  const valueToStore = Math.floor(Math.random() * 1000);
  const callData = await buildCallData(["function store(uint256)"], "store", [valueToStore]);

  const space = 1500;
  const nonce = generateNonceBitmap();

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

  const network_nonce = await getOrSyncNonce(provider, relayer.address);
 
  console.log(`Using network nonce: ${network_nonce}\n`); 

  const tx = await executeForward({
    provider,
    metaAddress: HUB_ADDRESS,
    fTuple: prep.fTuple,
    callData: prep.callData,
    signature,
    relayer,
    hasCaller: true,
    overrides: { nonce: network_nonce } // Ajusta el gasLimit si es necesario
  });

  console.log("Tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log(`✅ Mined in block ${receipt.blockNumber}\n`);
  console.log(`🎉 Store executed successfully!`);
}

main().catch(console.error);