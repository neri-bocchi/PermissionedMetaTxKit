// scripts/deployStorageMeta.js
import hre from "hardhat";
import "dotenv/config";
import { metaTx } from "../meta-exec-lib/src/index.js";

metaTx.setLogging(false);

const { ethers } = hre;

let StorageFactory;

const HUB_ADDRESS = process.env.HUB_ADDRESS;   // LNET MetaTxHub contract address
const RELAYER_PK = process.env.RELAYER_PK;     // Transaction Relayer (Must be allowlisted ask LNET Support Team to add it)
const SENDER_PK = process.env.SENDER_PK;       // Contract deployer owner (Must be allowlisted ask LNET Support Team to add it)

async function main() {
  if (!HUB_ADDRESS || !RELAYER_PK || !SENDER_PK) {
    throw new Error("Faltan env vars: HUB_ADDRESS, RELAYER_PK, SENDER_PK");
  }

  StorageFactory = await ethers.getContractFactory("Storage");

  console.log("Deploying Storage (EIP-2771) via MetaTxForwarder...\n");

  //  Wallets
  const provider = ethers.provider;
  const relayer = new ethers.Wallet(RELAYER_PK, provider);
  const sender = new ethers.Wallet(SENDER_PK, provider);

  // Combine bytecode + constructor args
  const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address"],
    [HUB_ADDRESS, sender.address]
  );
  const deployBytecode = StorageFactory.bytecode + constructorArgs.slice(2);

  // Metatx Nonce  - Bitmap Pattern
  const space = 0; // You can use different spaces to manage nonces separately
  const nonce = Math.floor(Math.random() * 1_000_000); // You need to use different nonces for each meta-tx

  // Prepare forward
  const { domain, types, message, fTuple, callData } = await metaTx.prepareForward({
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
    caller: relayer.address,
  });


  // Sign
  const signature = await metaTx.signForward(sender, domain, types, message);
  
  // Execute
  console.log("📡 Sending MetaTxForwarder...");  
  const tx = await metaTx.executeForward({
    provider,
    metaAddress: HUB_ADDRESS,
    fTuple,
    callData,
    signature,
    relayer,
    overrides: {type: 0,gasPrice: 0,gasLimit: 10_000_000},
    hasCaller: true,
    checkAllowlist: true,
  });

  console.log("Tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("Tx mined in block:", receipt.blockNumber, "\n");

  // Get deployed contract address
  const deployedAddress = metaTx.getDeployedAddress(receipt, metaTx.abi.META_ABI);
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
    if (error.data) {
      const decodedError = StorageFactory.interface.parseError(error.data);
      console.log('Nombre del error:', decodedError.name);
    } else {
      console.log('Error data is null, cannot decode specific error name.');
    }
    process.exit(1);
  });