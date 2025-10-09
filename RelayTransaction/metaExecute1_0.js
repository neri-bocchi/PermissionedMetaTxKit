import { ethers } from "ethers";
import "dotenv/config";

async function main() {

  const rpc = process.env.RPC_URL;
  const provider = new ethers.JsonRpcProvider(rpc);
  const { chainId } = await provider.getNetwork();


  const user = new ethers.Wallet(
    process.env.USER_PK,
    provider
  );

  // RELAYER que paga gas
  const relayer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  // Contrato MetaExecutor
//  const metaAddr   = ethers.getAddress("0x2186134C04AD3740c2264687ce67afAe2818FdA0"); // MetaExecutor
  const metaAddr   = ethers.getAddress("0x094815651AEe2CC0ea2445C34fc327323165025a");
  const metaAbi = [
    "function execute((address,address,uint256,uint32,uint256,uint256,bytes32),bytes,bytes) payable",
    "function isNonceUsed(address,uint32,uint256) view returns (bool)"
  ];
  const meta = new ethers.Contract(metaAddr, metaAbi, provider);

  // Llamada al Contrato Storage (ejemplo)
  const targetContractAddr = ethers.getAddress("0x98F6431E1CcdEc19087e3cE497275B2296fE46E7"); // Storage
  const iface = new ethers.Interface(["function store(uint256 _number)"]);
  const callData = iface.encodeFunctionData("store", [666n]);
  const dataHash = ethers.keccak256(callData);

  // Dominio y tipos EIP-712
  const domain = {
    name: "MetaExecutor",
    version: "1",
    chainId,
    verifyingContract: metaAddr,
  };

  async function findFreeNonce(from, space) {
  let n = 0n;
  while (await meta.isNonceUsed(from, space, n)) n++;
  return n;
}

  const types = {
    Forward: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "space", type: "uint32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "dataHash", type: "bytes32" },
    ],
  };

  //GESTION DE NONCES META-TARANSACTION
  // Space: canal de nonces (ej uno por usuario)
  // deadline : Expiracion del permiso (expresado como timestamp)
  // nonce único por (from, space), puede ser cualquier entero (no hace falta que sea ordenado)
  
  const space = 0;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 60);
  const nonce = await findFreeNonce(user.address,space); 
  console.log("Usando nonce:", nonce.toString());  
  // Valor en ETH a reenviar al target (si es necesario)
  const ethValue = 0n;

  // Estructura de la llamada
  const fParams = [
    ethers.getAddress(user.address),
    targetContractAddr,
    ethValue,
    space,
    nonce,
    deadline,
    dataHash,
  ];

  const message = {
    from: fParams[0],
    to: fParams[1],
    value: fParams[2],
    space: fParams[3],
    nonce: fParams[4],
    deadline: fParams[5],
    dataHash: fParams[6],
  };

  // Firmar con EIP-712
  const sig = await user.signTypedData(domain, types, message);

  // Ejecutar la transacción a través del relayer
  const tx = await meta.connect(relayer).execute(fParams, callData, sig);
  console.log("tx:", tx.hash);
  await tx.wait();
  console.log("Ejecutado");

  // === Obtener el valor almacenado ===
  const storageAbi = ["function retrieve() view returns (uint256)"];
  const storage = new ethers.Contract(targetContractAddr, storageAbi, provider);

  const storedValue = await storage.retrieve();
  console.log(`Valor almacenado actualmente en Storage: ${storedValue}`);

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});