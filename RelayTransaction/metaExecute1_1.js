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
    "function execute((address,address,uint256,uint32,uint256,uint256,bytes32,address),bytes,bytes) payable",
    "function isNonceUsed(address,uint32,uint256) view returns (bool)",
    "function isCallerAllowed(address) view returns (bool)"
  ];
  const meta = new ethers.Contract(metaAddr, metaAbi, provider);

  // Llamada al Contrato Storage (ejemplo)
  const targetContractAddr = ethers.getAddress("0x98F6431E1CcdEc19087e3cE497275B2296fE46E7"); // Storage
  const iface = new ethers.Interface(["function store(uint256 _number)"]);
  const randomNumber = Math.floor(Math.random() * 1000);
  const callData = iface.encodeFunctionData("store", [randomNumber]);
  const dataHash = ethers.keccak256(callData);

  // Dominio y tipos EIP-712
  const domain = {
    name: "MetaExecutor",
    version: "1",
    chainId,
    verifyingContract: metaAddr,
  };



  const types = {
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

  //GESTION DE NONCES META-TARANSACTION
  // Space: canal de nonces (ej uno por usuario)
  // deadline : Expiracion del permiso (expresado como timestamp)
  // nonce único por (from, space), puede ser cualquier entero (no hace falta que sea ordenado)
  
  const pendingNonce = await provider.getTransactionCount(relayer.address, "pending");
  const nonce_network = pendingNonce;

  const space = 0;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60); // Set deadline to 24 hours from now
  const nonce = nonce_network; 
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
    ethers.getAddress(relayer.address),  // caller field
  ];

  const message = {
    from: fParams[0],
    to: fParams[1],
    value: fParams[2],
    space: fParams[3],
    nonce: fParams[4],
    deadline: fParams[5],
    dataHash: fParams[6],
    caller: fParams[7],
  };

  // Check if relayer is allowed as caller
  const isAllowed = await meta.isCallerAllowed(relayer.address);
  console.log(`Relayer ${relayer.address} is allowed as caller:`, isAllowed);
  
  if (!isAllowed) {
    console.error("ERROR: Relayer is not in the caller allowlist!");
    console.log("You need to call setCallerAllowed() on the MetaExecutor contract first.");
    process.exit(1);
  }

  // Firmar con EIP-712
  const sig = await user.signTypedData(domain, types, message);

 

  console.log("Usando nonce de red del relayer:", nonce_network);
  // Ejecutar la transacción a través del relayer
  const tx = await meta.connect(relayer).execute(
  fParams,
  callData,
  sig,
  {
    value: ethValue,         
    nonce: nonce_network,          
    gasLimit: 200000,   
  }
);

  console.log("tx:", tx.hash);
  await tx.wait();
  console.log("Ejecutado Store con valor random:", randomNumber);

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