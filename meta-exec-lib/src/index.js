import { ethers } from "ethers";
import {
  META_ABI,
  EXECUTE_SIG
} from "./abis.js";

/** Codifica calldata del contrato destino. */
export function buildCallData(targetAbi, fnName, args) {
  const iface = new ethers.Interface(Array.isArray(targetAbi) ? targetAbi : [targetAbi]);
  return iface.encodeFunctionData(fnName, args);
}

/**
 * Prepara Forward + EIP-712.
 * - El nonce SIEMPRE debe venir dado por el usuario.
 * - `hasCaller = true` si el Forward incluye `caller` (tu versión pro).
 */
export async function prepareForward({
  provider,
  metaAddress,
  domainName = "PermissionedMetaTxHub",  // ← NUEVO: configurable
  domainVersion = "1",           // ← NUEVO: configurable
  hasCaller = true,
  from,
  to,
  value = 0n,
  space = 0,
  nonce,              // obligatorio, gestionado por el usuario
  deadline,           // deadline absoluto (timestamp) - NUEVO
  deadlineSec,        // o segundos desde ahora
  callData,
  caller              // requerido si hasCaller = true
}) {
  if (nonce === undefined || nonce === null)
    throw new Error("El parámetro nonce es obligatorio (lo gestiona el usuario).");
  if (!callData || callData === "0x") throw new Error("callData vacío");

  const chainId = Number((await provider.getNetwork()).chainId);
  const metaAddr = ethers.getAddress(metaAddress);

  const dataHash = ethers.keccak256(callData);
  
  // Calcular deadline: usar el parámetro si existe, sino calcular desde deadlineSec
  const finalDeadline = deadline !== undefined 
    ? BigInt(deadline) 
    : BigInt(Math.floor(Date.now() / 1000) + Number(deadlineSec || 600));

  const domain = { 
    name: domainName,           // ← USA EL PARÁMETRO
    version: domainVersion,     // ← USA EL PARÁMETRO
    chainId, 
    verifyingContract: metaAddr 
  };

  const types = {
    Forward: hasCaller
      ? [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "space", type: "uint32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "dataHash", type: "bytes32" },
          { name: "caller", type: "address" }
        ]
      : [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "space", type: "uint32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "dataHash", type: "bytes32" }
        ]
  };

  const message = hasCaller
    ? { from, to, value, space, nonce: BigInt(nonce), deadline: finalDeadline, dataHash, caller }
    : { from, to, value, space, nonce: BigInt(nonce), deadline: finalDeadline, dataHash };

  const fTuple = hasCaller
    ? [from, to, value, space, BigInt(nonce), finalDeadline, dataHash, caller]
    : [from, to, value, space, BigInt(nonce), finalDeadline, dataHash];

  return {
    domain,
    types,
    message,
    fTuple,
    callData,
    dataHash,
    chainId,
    EXECUTE_SIG
  };
}

/** Firma EIP-712. */
export function signForward(userWallet, domain, types, message) {
  return userWallet.signTypedData(domain, types, message);
}

/**
 * Ejecuta la metatx con el relayer.
 */
export async function executeForward({
  provider,
  metaAddress,
  fTuple,
  callData,
  signature,
  relayer,
  overrides = {},
  hasCaller = true,
  checkAllowlist = true
}) {


  const metaAddr   = ethers.getAddress(metaAddress);
  const executeSig = EXECUTE_SIG;
  const metaIface  = new ethers.Interface([`function ${executeSig} payable`]);
  const metaAbi    = META_ABI;
  const meta       = new ethers.Contract(metaAddr, metaAbi, provider);

  const execData = metaIface.encodeFunctionData("execute", [fTuple, callData, signature]);
  if (!execData || execData === "0x") throw new Error("execData vacío");

  if (checkAllowlist && hasCaller && meta.interface.getFunction("isCallerAllowed")) {
    const caller = fTuple[fTuple.length - 1];
    const allowed = await meta.isCallerAllowed(caller);
    if (!allowed) throw new Error(`caller ${caller} no permitido por MetaExecutor`);
  }

  const gasLimit = overrides.gasLimit ?? await provider.estimateGas({
    from: await relayer.getAddress(),
    to: metaAddr,
    data: execData,
    value: overrides.value ?? 0n
  });

  const tx = await relayer.sendTransaction({
    to: metaAddr,
    data: execData,
    value: overrides.value ?? 0n,
    gasLimit,
    nonce: overrides.nonce,
    gasPrice: overrides.gasPrice,
    maxFeePerGas: overrides.maxFeePerGas,
    maxPriorityFeePerGas: overrides.maxPriorityFeePerGas
  });

  return tx;
}