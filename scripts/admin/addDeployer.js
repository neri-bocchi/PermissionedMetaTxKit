import { ethers } from "ethers";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

/**
 * Script para agregar deployers al
 * 
 * Modos de uso:
 * 1. Agregar una sola address:
 *    node scripts/admin/addDeployers.js 0xABCD...
 * 
 * 2. Agregar múltiples addresses:
 *    node scripts/admin/addDeployers.js 0xABCD... 0x1234... 0x5678...
 * 
 * 3. Agregar desde un archivo (una address por línea):
 *    node scripts/admin/addDeployers.js --file deployers.txt
 * 
 * 4. Agregar en batch (usa setAllowedDeployers para múltiples):
 *    node scripts/admin/addDeployers.js --batch 0xABCD... 0x1234... 0x5678...
 */
const networkname = process.env.NETWORK || "unknown";

async function main() {
  const rpc = process.env.RPC_URL;

  console.log("Network name from .env:", networkname);
  if (!rpc) throw new Error("RPC_URL is not set in .env");
  
  const provider = new ethers.JsonRpcProvider(rpc);
  const owner = new ethers.Wallet(process.env.RELAYER_PK, provider);
  const metaAddr = ethers.getAddress(process.env.HUB_ADDRESS);

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         Add Deployers - MetaTxForwarder Manager            ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  console.log("Owner (sender)       :", owner.address);
  console.log("Hub address          :", metaAddr);
  console.log("Current block        :", await provider.getBlockNumber());
  console.log("");

  // Parse argumentos
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  let addresses = [];
  let useBatch = false;

  // Modo: --file
  if (args[0] === "--file") {
    if (args.length < 2) {
      console.error("❌ Error: Missing file path");
      console.error("Usage: node scripts/admin/addDeployers.js --file <filepath>");
      process.exit(1);
    }
    addresses = await readAddressesFromFile(args[1]);
  }
  // Modo: --batch
  else if (args[0] === "--batch") {
    if (args.length < 2) {
      console.error("❌ Error: No addresses provided for batch mode");
      process.exit(1);
    }
    useBatch = true;
    addresses = args.slice(1);
  }
  // Modo: directo (una o más addresses)
  else {
    addresses = args;
  }

  // Validar y normalizar addresses
  const validAddresses = [];
  for (const addr of addresses) {
    try {
      const normalized = ethers.getAddress(addr.trim());
      validAddresses.push(normalized);
    } catch (e) {
      console.error(`❌ Invalid address: ${addr}`);
      process.exit(1);
    }
  }

  if (validAddresses.length === 0) {
    console.error("❌ No valid addresses provided");
    process.exit(1);
  }

  console.log(`📋 Addresses to add: ${validAddresses.length}`);
  validAddresses.forEach((addr, i) => {
    console.log(`   ${i + 1}. ${addr}`);
  });
  console.log("");

  // Verificar ownership
  const ownerAbi = ["function owner() view returns (address)"];
  const ownerContract = new ethers.Contract(metaAddr, ownerAbi, provider);
  
  try {
    const contractOwner = await ownerContract.owner();
    if (contractOwner.toLowerCase() !== owner.address.toLowerCase()) {
      console.error("❌ ERROR: You are not the owner of this contract");
      console.error(`   Contract owner: ${contractOwner}`);
      console.error(`   Your address  : ${owner.address}`);
      process.exit(1);
    }
    console.log("✅ Ownership verified\n");
  } catch (e) {
    console.error("❌ Could not verify ownership:", e.message);
    process.exit(1);
  }

  // Ejecutar según el modo
  if (useBatch && validAddresses.length > 1) {
    await addDeployersBatch(metaAddr, owner, validAddresses);
  } else {
    await addDeployersOneByOne(metaAddr, owner, validAddresses);
  }
}

/**
 * Agrega deployers uno por uno usando setAllowedDeployer()
 */
async function addDeployersOneByOne(hubAddress, signer, addresses) {
  console.log("📝 Mode: Adding deployers one by one\n");
  
  const abi = [
    "function setAllowedDeployer(address account, bool allowed) external"
  ];
  const hub = new ethers.Contract(hubAddress, abi, signer);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    const num = i + 1;
    
    console.log(`[${num}/${addresses.length}] Processing ${addr}...`);
    
    try {
      // Estimate gas
      const gasEstimate = await hub.setAllowedDeployer.estimateGas(addr, true);
      console.log(`   ⛽ Gas estimate: ${gasEstimate.toString()}`);
      
      var tx=null;
      // Send transaction
      if (networkname === "LNET") {
        console.log("   ⚙️  Using LNET tx options");
        tx = await hub.setAllowedDeployer(addr, true, {gasPrice:0, gasLimit:4_000_000, type: 0 });
      
      }
        else{        console.log("   ⚙️  Standard call", networkname);

  tx = await hub.setAllowedDeployer(addr, true);
    
        }
      

      console.log(`   📤 Tx sent: ${tx.hash}`);
      
      // Wait for confirmation
      const receipt = await tx.wait();
      console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);
      console.log(`   ⛽ Gas used: ${receipt.gasUsed.toString()}\n`);
      
      successCount++;
    } catch (e) {
      console.error(`   ❌ Failed: ${e.shortMessage || e.message}\n`);
      failCount++;
      
      // Si falla uno, preguntar si continuar
      if (addresses.length > 1 && i < addresses.length - 1) {
        console.log("   ⚠️  Continue with remaining addresses? (Ctrl+C to abort)\n");
        await sleep(2000);
      }
    }
  }

  // Resumen
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║                         SUMMARY                            ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`✅ Successfully added  : ${successCount}`);
  console.log(`❌ Failed              : ${failCount}`);
  console.log(`📊 Total processed     : ${addresses.length}`);
  console.log("");
}

/**
 * Agrega múltiples deployers en una sola transacción usando setAllowedDeployers()
 */
async function addDeployersBatch(hubAddress, signer, addresses) {
  console.log("📦 Mode: Adding deployers in batch (single transaction)\n");
  
  const abi = [
    "function setAllowedDeployers(address[] calldata accounts, bool allowed) external"
  ];
  const hub = new ethers.Contract(hubAddress, abi, signer);

  try {
    // Estimate gas
    console.log("⛽ Estimating gas...");
    const gasEstimate = await hub.setAllowedDeployers.estimateGas(addresses, true);
    console.log(`   Gas estimate: ${gasEstimate.toString()}\n`);
    
    // Send transaction
    console.log("📤 Sending batch transaction...");

    if (networkname,toUpperCase === "LNET") 
{
        console.log("   ⚙️  Using LNET tx options");
        tx = await hub.setAllowedDeployer(addr, true, {gasPrice:0, gasLimit:4_000_000, type: 0 });
      
      }
    else
      tx = await hub.setAllowedDeployers(addresses, true);


    console.log(`   Tx hash: ${tx.hash}\n`);
    
    // Wait for confirmation
    console.log("⏳ Waiting for confirmation...");
    const receipt = await tx.wait();
    
    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║                    BATCH SUCCESS                           ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log(`✅ Block number        : ${receipt.blockNumber}`);
    console.log(`⛽ Gas used            : ${receipt.gasUsed.toString()}`);
    console.log(`📊 Deployers added     : ${addresses.length}`);
    console.log("");
    
  } catch (e) {
    console.error("\n❌ Batch transaction failed:");
    console.error(`   Error: ${e.shortMessage || e.message}`);
    
    if (e.reason) {
      console.error(`   Reason: ${e.reason}`);
    }
    
    console.error("\n💡 Suggestions:");
    console.error("   1. Try adding deployers one by one (remove --batch flag)");
    console.error("   2. Check if the function setAllowedDeployers exists in your contract");
    console.error("   3. Verify you have enough gas");
    console.error("");
    
    process.exit(1);
  }
}

/**
 * Lee addresses desde un archivo (una por línea)
 */
async function readAddressesFromFile(filepath) {
  try {
    const fullPath = path.resolve(filepath);
    console.log(`📂 Reading from file: ${fullPath}\n`);
    
    const content = fs.readFileSync(fullPath, "utf8");
    const lines = content
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith("#")); // Ignorar líneas vacías y comentarios
    
    if (lines.length === 0) {
      throw new Error("File is empty or contains no valid addresses");
    }
    
    console.log(`   Found ${lines.length} addresses in file\n`);
    return lines;
    
  } catch (e) {
    console.error(`❌ Error reading file: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Helper para esperar
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Imprime instrucciones de uso
 */
function printUsage() {
  console.log("Usage:");
  console.log("");
  console.log("  Add single deployer:");
  console.log("    node scripts/admin/addDeployers.js 0xABCD...");
  console.log("");
  console.log("  Add multiple deployers (one by one):");
  console.log("    node scripts/admin/addDeployers.js 0xABCD... 0x1234... 0x5678...");
  console.log("");
  console.log("  Add multiple deployers (batch - single tx):");
  console.log("    node scripts/admin/addDeployers.js --batch 0xABCD... 0x1234... 0x5678...");
  console.log("");
  console.log("  Add from file (one address per line):");
  console.log("    node scripts/admin/addDeployers.js --file deployers.txt");
  console.log("");
  console.log("File format (deployers.txt):");
  console.log("  0xABCD1234567890...");
  console.log("  0x1234567890ABCD...");
  console.log("  # Comments start with #");
  console.log("  0x5678901234ABCD...");
  console.log("");
}

// Ejecutar
main().catch((e) => {
  console.error("\n❌ Unhandled error:");
  console.error(e);
  process.exit(1);
});