// debugComparison.js - Compara ambos métodos
import hre from "hardhat";
import "dotenv/config";
import { prepareForward } from "../meta-exec-lib/src/index.js";

const { ethers } = hre;

const HUB_ADDRESS = process.env.HUB_ADDRESS;
const RELAYER_PK = process.env.RELAYER_PK;
const SENDER_PK = process.env.SENDER_PK;

async function main() {
  const provider = ethers.provider;
  const relayer = new ethers.Wallet(RELAYER_PK, provider);
  const sender = new ethers.Wallet(SENDER_PK, provider);

  const StorageFactory = await ethers.getContractFactory("Storage");
  const deployBytecode = StorageFactory.bytecode;

  const space = 0;
  const nonce = 123456;
  const deadlineTimestamp = Math.floor(Date.now() / 1000) + 3600; // ← calcular UNA vez
  const deadline = deadlineTimestamp;

  console.log("=== MÉTODO ORIGINAL (que funciona) ===\n");

  // Dominio del contrato real
  const REAL_DOMAIN = {
    name: "PermissionedMetaTxHub",
    version: "1",
    chainId: 80002,
    verifyingContract: HUB_ADDRESS,
  };

  const FORWARD_TYPES = {
    Forward: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "space", type: "uint32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "dataHash", type: "bytes32" },
      { name: "caller", type: "address" },
    ],
  };

  const dataHash = ethers.keccak256(deployBytecode);

  const forward = {
    from: sender.address,
    to: ethers.ZeroAddress,
    value: 0n,
    space,
    nonce,
    deadline,
    dataHash,
    caller: relayer.address,
  };

  console.log("Domain:", REAL_DOMAIN);
  console.log("Message:", forward);
  
  const sig1 = await sender.signTypedData(REAL_DOMAIN, FORWARD_TYPES, forward);
  console.log("Signature:", sig1);

  console.log("\n=== MÉTODO CON LIBRERÍA ===\n");

  const libResult = await prepareForward({
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

  console.log("Domain:", libResult.domain);
  console.log("Message:", libResult.message);

  const sig2 = await sender.signTypedData(libResult.domain, libResult.types, libResult.message);
  console.log("Signature:", sig2);

  console.log("\n=== COMPARACIÓN ===\n");
  console.log("Dominios iguales?", JSON.stringify(REAL_DOMAIN) === JSON.stringify(libResult.domain));
  console.log("Firmas iguales?", sig1 === sig2);
  
  if (sig1 !== sig2) {
    console.log("\n⚠️  LAS FIRMAS SON DIFERENTES!");
    console.log("\nDiferencias en el dominio:");
    console.log("  name:", REAL_DOMAIN.name, "vs", libResult.domain.name);
    console.log("  version:", REAL_DOMAIN.version, "vs", libResult.domain.version);
    console.log("  chainId:", REAL_DOMAIN.chainId, "vs", libResult.domain.chainId);
    console.log("  verifyingContract:", REAL_DOMAIN.verifyingContract, "vs", libResult.domain.verifyingContract);
  } else {
    console.log("\n✅ Las firmas coinciden!");
  }
}

main().catch(console.error);