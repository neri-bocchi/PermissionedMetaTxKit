import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Get the directory name in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (two levels up from scripts/admin/)
const envPath = path.resolve(__dirname, "../../.env");
console.log(`Loading .env from: ${envPath}\n`);
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.error("❌ Error loading .env file:", result.error.message);
  process.exit(1);
}

/**
 * Script de diagnóstico profundo para el MetaTxForwarder
 * Verifica todas las funciones y permisos
 */

async function main() {
  // Verificar que las variables existan
  console.log("🔧 Environment Variables Check:");
  console.log("   RPC_URL         :", process.env.RPC_URL ? "✅ Set" : "❌ Missing");
  console.log("   RELAYER_PK      :", process.env.RELAYER_PK ? "✅ Set" : "❌ Missing");
  console.log("   HUB_ADDRESS     :", process.env.HUB_ADDRESS ? "✅ Set" : "❌ Missing");
  console.log("");
  
  const rpc = process.env.RPC_URL;
  if (!rpc) {
    console.error("❌ RPC_URL is not set in .env");
    process.exit(1);
  }
  
  const relayerPk = process.env.RELAYER_PK;
  if (!relayerPk) {
    console.error("❌ RELAYER_PK is not set in .env");
    process.exit(1);
  }
  
  const hubAddress = process.env.HUB_ADDRESS;
  if (!hubAddress) {
    console.error("❌ HUB_ADDRESS is not set in .env");
    process.exit(1);
  }
  
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(relayerPk, provider);
  const metaAddr = ethers.getAddress(hubAddress);

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║           Deep Contract Diagnostic Tool                    ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  console.log("Your address         :", wallet.address);
  console.log("Hub address          :", metaAddr);
  console.log("Current block        :", await provider.getBlockNumber());
  console.log("Network              :", (await provider.getNetwork()).name);
  console.log("");

  // 1. Verificar que el contrato existe
  console.log("📦 1. Checking if contract exists...");
  const code = await provider.getCode(metaAddr);
  if (code === "0x") {
    console.error("   ❌ ERROR: No contract found at this address!");
    console.error("   The address has no bytecode. Check your HUB_ADDRESS in .env");
    process.exit(1);
  }
  console.log(`   ✅ Contract exists (${code.length} bytes)\n`);

  // 2. Verificar ownership
  console.log("👤 2. Checking ownership...");
  try {
    const ownerAbi = ["function owner() view returns (address)"];
    const contract = new ethers.Contract(metaAddr, ownerAbi, provider);
    const owner = await contract.owner();
    console.log(`   Contract owner   : ${owner}`);
    console.log(`   Your address     : ${wallet.address}`);
    
    if (owner.toLowerCase() === wallet.address.toLowerCase()) {
      console.log("   ✅ You are the owner\n");
    } else {
      console.log("   ❌ You are NOT the owner\n");
      console.log("   ⚠️  Only the owner can add deployers");
      process.exit(1);
    }
  } catch (e) {
    console.log(`   ❌ Cannot read owner: ${e.message}\n`);
  }

  // 3. Verificar balance de ETH
  console.log("💰 3. Checking ETH balance...");
  const balance = await provider.getBalance(wallet.address);
  console.log(`   Balance          : ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    console.log("   ⚠️  WARNING: You have no ETH for gas\n");
  } else {
    console.log("   ✅ Sufficient balance\n");
  }

  // 4. Verificar qué funciones existen
  console.log("🔍 4. Checking available functions...");
  
  const functionsToTest = [
    {
      name: "setAllowedDeployer",
      sig: "function setAllowedDeployer(address account, bool allowed) external",
      type: "write"
    },
    {
      name: "setAllowedDeployers", 
      sig: "function setAllowedDeployers(address[] calldata accounts, bool allowed) external",
      type: "write"
    },
    {
      name: "allowedDeployers",
      sig: "function allowedDeployers(address) view returns (bool)",
      type: "read"
    },
    {
      name: "isCallerAllowed",
      sig: "function isCallerAllowed(address) view returns (bool)",
      type: "read"
    },
    {
      name: "gasLimitPerBlock",
      sig: "function gasLimitPerBlock(address) view returns (uint256)",
      type: "read"
    }
  ];

  for (const func of functionsToTest) {
    try {
      const iface = new ethers.Interface([func.sig]);
      const funcFragment = iface.fragments[0];
      const selector = iface.getFunction(funcFragment.name).selector;
      
      // Verificar si el selector existe en el bytecode
      const exists = code.includes(selector.slice(2));
      
      if (exists) {
        console.log(`   ✅ ${func.name.padEnd(25)} : EXISTS`);
      } else {
        console.log(`   ❌ ${func.name.padEnd(25)} : NOT FOUND`);
      }
    } catch (e) {
      console.log(`   ⚠️  ${func.name.padEnd(25)} : ERROR`);
    }
  }
  console.log("");

  // 5. Intentar leer el estado actual de la address que queremos agregar
  console.log("📖 5. Testing read functions...");
  const testAddr = process.argv[2] || wallet.address;
  console.log(`   Testing with address: ${testAddr}\n`);

  // Test allowedDeployers
  try {
    const abi = ["function allowedDeployers(address) view returns (bool)"];
    const contract = new ethers.Contract(metaAddr, abi, provider);
    const result = await contract.allowedDeployers(testAddr);
    console.log(`   allowedDeployers(${testAddr.slice(0, 10)}...)`);
    console.log(`   ✅ Current value: ${result}`);
    
    if (result === true) {
      console.log(`   ℹ️  This address is already allowed as deployer`);
    }
  } catch (e) {
    console.log(`   allowedDeployers()`);
    console.log(`   ❌ Failed: ${e.shortMessage || e.message}`);
  }
  console.log("");

  // Test isCallerAllowed
  try {
    const abi = ["function isCallerAllowed(address) view returns (bool)"];
    const contract = new ethers.Contract(metaAddr, abi, provider);
    const result = await contract.isCallerAllowed(testAddr);
    console.log(`   isCallerAllowed(${testAddr.slice(0, 10)}...)`);
    console.log(`   ✅ Current value: ${result}`);
  } catch (e) {
    console.log(`   isCallerAllowed()`);
    console.log(`   ❌ Failed: ${e.shortMessage || e.message}`);
  }
  console.log("");

  // 6. Intentar simular la transacción con estimateGas
  console.log("⛽ 6. Testing transaction simulation...");
  try {
    const abi = ["function setAllowedDeployer(address account, bool allowed) external"];
    const contract = new ethers.Contract(metaAddr, abi, wallet);
    
    console.log(`   Simulating: setAllowedDeployer(${testAddr}, true)`);
    const gasEstimate = await contract.setAllowedDeployer.estimateGas(testAddr, true);
    console.log(`   ✅ Gas estimate: ${gasEstimate.toString()}`);
    console.log(`   ℹ️  Transaction would succeed!\n`);
  } catch (e) {
    console.log(`   ❌ Simulation failed!`);
    console.log(`   Error: ${e.shortMessage || e.message}`);
    
    if (e.data) {
      console.log(`   Error data: ${e.data}`);
    }
    
    // Intentar decodificar el error
    if (e.reason) {
      console.log(`   Reason: ${e.reason}`);
    }

    console.log("\n   Possible causes:");
    console.log("   1. Address is zero address (0x000...000)");
    console.log("   2. You are not the owner");
    console.log("   3. Contract is paused (if pause functionality exists)");
    console.log("   4. Function doesn't exist in deployed contract");
    console.log("   5. Some internal require() is failing");
    console.log("");

    // Intentar verificar si es zero address
    if (testAddr === ethers.ZeroAddress) {
      console.log("   ⚠️  Detected: You're trying to add the zero address!");
      console.log("   The contract rejects zero address to prevent errors.");
    }
  }

  // 7. Leer el bytecode completo del contrato
  console.log("🔬 7. Analyzing contract bytecode...");
  
  // Buscar strings de error conocidos
  const errorStrings = [
    "ZeroAddress",
    "CallerNotAllowed", 
    "Paused",
    "Ownable"
  ];

  console.log("   Looking for error strings in bytecode:");
  for (const errStr of errorStrings) {
    const hexStr = Buffer.from(errStr).toString('hex');
    if (code.toLowerCase().includes(hexStr)) {
      console.log(`   ✅ Found: "${errStr}"`);
    }
  }
  console.log("");

  // 8. Verificar si hay función pause
  console.log("⏸️  8. Checking if contract is paused...");
  try {
    const abi = ["function paused() view returns (bool)"];
    const contract = new ethers.Contract(metaAddr, abi, provider);
    const isPaused = await contract.paused();
    console.log(`   Paused status    : ${isPaused}`);
    
    if (isPaused) {
      console.log("   ❌ Contract is PAUSED! This is why transactions fail.");
      console.log("   You need to unpause the contract first.\n");
    } else {
      console.log("   ✅ Contract is not paused\n");
    }
  } catch (e) {
    console.log(`   ℹ️  No pause function found (contract doesn't have pause feature)\n`);
  }

  // 9. Verificar el ABI completo del contrato (si está verificado)
  console.log("📄 9. Contract Information:");
  console.log(`   Address: ${metaAddr}`);
  console.log(`   Explorer: https://basescan.org/address/${metaAddr}`);
  console.log(`   Check if contract is verified on explorer\n`);

  // Final recommendations
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║                    RECOMMENDATIONS                         ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Next steps:");
  console.log("1. Verify your contract on block explorer (Basescan)");
  console.log("2. Check the verified source code to see the exact function signature");
  console.log("3. If contract has a pause feature, ensure it's not paused");
  console.log("4. Make sure the address you're adding is not the zero address");
  console.log("5. Try calling the function directly from block explorer to see error message");
  console.log("");
}

main().catch((e) => {
  console.error("\n❌ Diagnostic failed:");
  console.error(e);
  process.exit(1);
});