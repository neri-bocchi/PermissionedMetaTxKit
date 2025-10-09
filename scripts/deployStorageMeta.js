import { ethers } from "ethers";
import fs from "node:fs";
import dotenv from "dotenv";
dotenv.config();

import {
  prepareForward,
  signForward,
  executeForward
} from "../meta-exec-lib/src/index.js";
import { randomInt } from "node:crypto";

const RPC_URL = process.env.RPC_URL;
const SIGNER_PK = process.env.SENDER_PK;
const RELAYER_PK = process.env.RELAYER_PK;
const HUB_ADDRESS = process.env.HUB_ADDRESS;
const STORE_ARTIFACT = "./artifacts/contracts/Storage.sol/Storage.json";
const HAS_CALLER = "true";
const SPACE = "0";
const VALUE_WEI = "0";
const DEADLINE_SEC = "1200";
const CALLER = new ethers.Wallet(RELAYER_PK).address;


async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(SIGNER_PK, provider);
  const relayer = new ethers.Wallet(RELAYER_PK, provider);

  // Nonce único para el usuario
  const userNonceArg = randomInt(1, 1000000);

  // Bytecode del contrato Storage
  const art = JSON.parse(fs.readFileSync(STORE_ARTIFACT, "utf8"));
  const initCode = art.bytecode;
  if (!initCode || initCode === "0x") throw new Error("INIT CODE vacío para Storage.");

  // Armar el Forward para deploy

  const prep = await prepareForward({
    provider,
    metaAddress: HUB_ADDRESS,
    hasCaller: HAS_CALLER === "true",
    from: await signer.getAddress(),
    to: ethers.ZeroAddress,
    value: BigInt(VALUE_WEI),
    space: Number(SPACE) >>> 0,
    nonce: BigInt(userNonceArg),
    deadlineSec: Number(DEADLINE_SEC),
    callData: initCode,
    caller: CALLER
  });

  // Firmar el Forward
  const signature = await signForward(signer, prep.domain, prep.types, prep.message);

  // Ejecutar la meta-tx con el relayer
  const tx = await executeForward({
    provider,
    metaAddress: HUB_ADDRESS,
    fTuple: prep.fTuple,
    callData: prep.callData,
    signature,
    relayer,
    hasCaller: HAS_CALLER === "true",
    overrides: { gasLimit: 5000000 }
  });

  const rcpt = await tx.wait();
  console.log("OK ➜ Tx hash:", rcpt.hash);

  // Extraer la dirección desplegada si el hub emite evento
  try {
    const metaAbi = (await import("./abis.js")).META_ABI;
    const contract = new ethers.Contract(HUB_ADDRESS, metaAbi, provider);
    for (const log of rcpt.logs) {
      try {
        const ev = contract.interface.parseLog(log);
        if (ev?.name && (ev.name.includes("Deployed") || ev.name.includes("ContractDeployed"))) {
          const addr = ev.args?.deployed ?? ev.args?.resultAddress ?? ev.args?.[0];
          if (addr) {
            console.log("Contrato Storage desplegado en:", addr);
            break;
          }
        }
      } catch {}
    }
  } catch {
    console.log("error extrayendo dirección desplegada");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});