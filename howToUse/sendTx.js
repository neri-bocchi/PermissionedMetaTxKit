import { ethers } from "ethers";
import { buildCallData, prepareForward, signForward, executeForward } from "./../meta-exec-lib/src/index.js";
import "dotenv/config";

async function run() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

  const user    = new ethers.Wallet(process.env.SENDER_PK, provider);
  const relayer = new ethers.Wallet(process.env.RELAYER_PK, provider);

  const metaAddress   = "0x094815651AEe2CC0ea2445C34fc327323165025a";
  const targetAddress = "0x98F6431E1CcdEc19087e3cE497275B2296fE46E7";

  const random = Math.floor(Math.random() * 1000);
  const callData = buildCallData(["function store(uint256)"], "store", [random]);

  const space = 1500;
  const randomNumber = Math.floor(Math.random() * 1000);
  const userNonce = randomNumber;

  const prep = await prepareForward({
    provider,
    metaAddress,
    hasCaller: true,
    from: user.address,
    to: targetAddress,
    callData,
    caller: relayer.address,
    value: 0n,
    space: space,
    nonce: userNonce,
    deadlineSec: 24 * 60 * 60
  });

  const sig = await signForward(user, prep.domain, prep.types, prep.message);

  const tx = await executeForward({
    provider,
    metaAddress,
    fTuple: prep.fTuple,
    callData: prep.callData,
    signature: sig,
    relayer,
    hasCaller: true
  });

  console.log("tx:", tx.hash);
  await tx.wait();
  console.log("store ejecutado con nonce usuario:", userNonce.toString());
}

run().catch(console.error);