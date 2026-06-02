import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Get the directory name in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root
const envPath = path.resolve(__dirname, "../../.env");
const result = dotenv.config({ path: envPath, override: true });

if (result.error) {
  console.error("❌ Error loading .env file:", result.error.message);
  console.error(`   Tried to load from: ${envPath}`);
  process.exit(1);
}

/**
 * Script para gestionar buckets de gas para deploys
 * 
 * Comandos:
 * 1. Ver configuración actual:
 *    node scripts/admin/manageBuckets.js info
 * 
 * 2. Ver estado de un deployer específico:
 *    node scripts/admin/manageBuckets.js status <deployerAddress>
 * 
 * 3. Configurar bucket global:
 *    node scripts/admin/manageBuckets.js set <gasLimit> <durationSeconds>
 *    Ejemplo: node scripts/admin/manageBuckets.js set 10000000 600
 * 
 * 4. Desactivar límite de bucket:
 *    node scripts/admin/manageBuckets.js disable
 */

async function main() {
  // Verificar variables de entorno
  const rpc = process.env.RPC_URL;
  const relayerPk = process.env.RELAYER_PK;
  const hubAddress = process.env.HUB_ADDRESS;
  
  if (!rpc || !relayerPk || !hubAddress) {
    console.error("❌ Missing required environment variables");
    process.exit(1);
  }
  
  const provider = new ethers.JsonRpcProvider(rpc);
  const owner = new ethers.Wallet(relayerPk, provider);
  const metaAddr = ethers.getAddress(hubAddress);

  const command = process.argv[2]?.toLowerCase();

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         Deploy Gas Bucket Manager - MetaTxForwarder       ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  console.log("Owner address        :", owner.address);
  console.log("Hub address          :", metaAddr);
  console.log("Current block        :", await provider.getBlockNumber());
  console.log("");

  // Verificar ownership
  await verifyOwnership(metaAddr, owner, provider);

  // Ejecutar comando
  switch (command) {
    case "info":
      await showInfo(metaAddr, provider);
      break;
    case "status":
      await showDeployerStatus(metaAddr, provider);
      break;
    case "set":
      await setBucketConfig(metaAddr, owner);
      break;
    case "disable":
      await disableBucket(metaAddr, owner);
      break;
    case "help":
    case undefined:
      printUsage();
      break;
    default:
      console.error(`❌ Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

/**
 * Verifica que el usuario sea owner del contrato
 */
async function verifyOwnership(hubAddress, wallet, provider) {
  try {
    const abi = ["function owner() view returns (address)"];
    const contract = new ethers.Contract(hubAddress, abi, provider);
    const contractOwner = await contract.owner();
    
    if (contractOwner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.error("❌ ERROR: You are not the owner of this contract");
      console.error(`   Contract owner: ${contractOwner}`);
      console.error(`   Your address  : ${wallet.address}`);
      process.exit(1);
    }
    console.log("✅ Ownership verified\n");
  } catch (e) {
    console.error("❌ Could not verify ownership:", e.message);
    process.exit(1);
  }
}

/**
 * Muestra la configuración global del bucket
 */
async function showInfo(hubAddress, provider) {
  console.log("📊 GLOBAL BUCKET CONFIGURATION");
  console.log("═".repeat(60));
  console.log("");

  const abi = [
    "function deployGasBucketLimit() view returns (uint256)",
    "function deployGasBucketDuration() view returns (uint64)"
  ];

  try {
    const contract = new ethers.Contract(hubAddress, abi, provider);
    
    const limit = await contract.deployGasBucketLimit();
    const duration = await contract.deployGasBucketDuration();

    console.log("Gas Bucket Limit     :", limit.toString(), "gas units");
    console.log("Bucket Duration      :", duration.toString(), "seconds");
    
    if (duration > 0n) {
      const minutes = Number(duration) / 60;
      const hours = minutes / 60;
      console.log("                     :", `(${minutes.toFixed(2)} minutes / ${hours.toFixed(2)} hours)`);
    }

    console.log("");

    if (limit === 0n || duration === 0n) {
      console.log("⚠️  Status: DISABLED");
      console.log("   No gas limit enforced for deploys");
    } else {
      console.log("✅ Status: ACTIVE");
      console.log(`   Deployers can use up to ${limit.toString()} gas`);
      console.log(`   within a ${duration.toString()} second window`);
    }

    console.log("");
    console.log("💡 What this means:");
    console.log("   - Each deployer has their own independent bucket");
    console.log("   - Gas usage is tracked per deployer address");
    console.log(`   - Window resets after ${duration.toString()} seconds`);
    console.log("   - This prevents deploy spam and gas griefing");
    console.log("");

  } catch (e) {
    console.error("❌ Error reading bucket config:", e.message);
    console.log("\n💡 This might mean:");
    console.log("   - The function doesn't exist in your deployed contract");
    console.log("   - You need to upgrade your contract to the latest version");
  }
}

/**
 * Muestra el estado del bucket para un deployer específico
 */
async function showDeployerStatus(hubAddress, provider) {
  const deployerAddr = process.argv[3];
  
  if (!deployerAddr) {
    console.error("❌ Missing deployer address");
    console.error("Usage: node scripts/admin/manageBuckets.js status <deployerAddress>");
    process.exit(1);
  }

  const deployer = ethers.getAddress(deployerAddr);

  console.log(`📈 DEPLOYER STATUS: ${deployer}`);
  console.log("═".repeat(60));
  console.log("");

  const abi = [
    "function deployGasWindowState(address from) view returns (uint256 used, uint256 limit, uint64 startedAt, uint64 duration, uint256 nowTs)",
    "function allowedDeployers(address) view returns (bool)"
  ];

  try {
    const contract = new ethers.Contract(hubAddress, abi, provider);
    
    // Verificar si está permitido
    let isAllowed = false;
    try {
      isAllowed = await contract.allowedDeployers(deployer);
      console.log("Is Allowed to Deploy :", isAllowed ? "✅ YES" : "❌ NO");
    } catch (e) {
      console.log("Is Allowed to Deploy : ⚠️  Cannot verify (function may not exist)");
    }

    console.log("");

    // Obtener estado del bucket
    const [used, limit, startedAt, duration, nowTs] = await contract.deployGasWindowState(deployer);

    console.log("--- Gas Bucket Window ---");
    console.log("Gas used in window   :", used.toString());
    console.log("Gas limit            :", limit.toString());
    console.log("Window started at    :", startedAt.toString());
    
    if (startedAt > 0n) {
      const startDate = new Date(Number(startedAt) * 1000);
      console.log("                     :", startDate.toISOString());
    }

    console.log("Window duration      :", duration.toString(), "seconds");
    console.log("Current timestamp    :", nowTs.toString());

    console.log("");

    // Calcular estado
    if (limit === 0n || duration === 0n) {
      console.log("📊 Status: NO LIMIT");
      console.log("   This deployer has no gas restrictions");
    } else {
      const remaining = limit > used ? limit - used : 0n;
      const percentUsed = limit > 0n ? (Number(used) * 100 / Number(limit)).toFixed(2) : "0.00";
      
      console.log("--- Usage Summary ---");
      console.log("Gas remaining        :", remaining.toString());
      console.log("Percentage used      :", percentUsed + "%");
      
      // Verificar si la ventana expiró
      if (startedAt > 0n && duration > 0n) {
        const windowEnd = Number(startedAt) + Number(duration);
        const now = Number(nowTs);
        
        if (now >= windowEnd) {
          console.log("⏰ Window expired    : YES (will reset on next deploy)");
        } else {
          const remaining = windowEnd - now;
          const remainingMin = (remaining / 60).toFixed(2);
          console.log("⏰ Window expires in :", `${remaining}s (${remainingMin} minutes)`);
        }
      }

      console.log("");

      if (used >= limit) {
        console.log("⚠️  WARNING: Gas limit reached!");
        console.log("   This deployer cannot deploy until the window resets");
      } else if (Number(percentUsed) > 80) {
        console.log("⚠️  WARNING: High gas usage (>80%)");
      } else if (!isAllowed) {
        console.log("⚠️  WARNING: Deployer is not in allowlist!");
        console.log("   Add this address to allowedDeployers first");
      } else {
        console.log("✅ Status: OK - Can deploy contracts");
      }
    }

    console.log("");

  } catch (e) {
    console.error("❌ Error reading deployer status:", e.message);
    console.log("\n💡 This might mean:");
    console.log("   - The function doesn't exist in your deployed contract");
    console.log("   - The address is invalid");
  }
}

/**
 * Configura el bucket de gas global
 */
async function setBucketConfig(hubAddress, wallet) {
  const argLimit = process.argv[3];
  const argDuration = process.argv[4];

  if (!argLimit || !argDuration) {
    console.error("❌ Missing parameters");
    console.error("Usage: node scripts/admin/manageBuckets.js set <gasLimit> <durationSeconds>");
    console.error("\nExamples:");
    console.error("  10M gas, 10 minutes : node scripts/admin/manageBuckets.js set 10000000 600");
    console.error("  5M gas, 5 minutes   : node scripts/admin/manageBuckets.js set 5000000 300");
    console.error("  20M gas, 1 hour     : node scripts/admin/manageBuckets.js set 20000000 3600");
    process.exit(1);
  }

  const limit = BigInt(argLimit);
  const duration = BigInt(argDuration);

  console.log("🔧 SETTING BUCKET CONFIGURATION");
  console.log("═".repeat(60));
  console.log("");
  console.log("New gas limit        :", limit.toString(), "gas units");
  console.log("New duration         :", duration.toString(), "seconds");
  
  const minutes = Number(duration) / 60;
  const hours = minutes / 60;
  console.log("                     :", `(${minutes.toFixed(2)} minutes / ${hours.toFixed(2)} hours)`);
  console.log("");

  const abi = [
    "function setDeployGasBucketConfig(uint256 limit, uint64 durationSeconds) external",
    "function deployGasBucketLimit() view returns (uint256)",
    "function deployGasBucketDuration() view returns (uint64)"
  ];

  try {
    const contract = new ethers.Contract(hubAddress, abi, wallet);

    // Mostrar valores actuales
    const currentLimit = await contract.deployGasBucketLimit();
    const currentDuration = await contract.deployGasBucketDuration();
    
    console.log("Current limit        :", currentLimit.toString());
    console.log("Current duration     :", currentDuration.toString());
    console.log("");

    if (currentLimit === limit && currentDuration === duration) {
      console.log("⚠️  No change needed - values are already set");
      return;
    }

    // Estimate gas
    console.log("⛽ Estimating gas...");
    const gasEstimate = await contract.setDeployGasBucketConfig.estimateGas(limit, duration);
    console.log(`   Gas estimate: ${gasEstimate.toString()}`);
    console.log("");

    // Enviar transacción
    console.log("📤 Sending transaction...");
    const tx = await contract.setDeployGasBucketConfig(limit, duration);
    console.log(`   Tx hash: ${tx.hash}`);
    console.log("");

    // Esperar confirmación
    console.log("⏳ Waiting for confirmation...");
    const receipt = await tx.wait();
    
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║                    SUCCESS                                 ║");
    console.log("╚════════════════════════════════════════════════════════════╝");
    console.log("");
    console.log("✅ Block number      :", receipt.blockNumber);
    console.log("⛽ Gas used          :", receipt.gasUsed.toString());
    console.log("");

    // Verificar nuevos valores
    const afterLimit = await contract.deployGasBucketLimit();
    const afterDuration = await contract.deployGasBucketDuration();
    
    console.log("--- Updated Configuration ---");
    console.log("Gas limit            :", afterLimit.toString());
    console.log("Duration             :", afterDuration.toString(), "seconds");
    console.log("");

    if (afterLimit === 0n || afterDuration === 0n) {
      console.log("⚠️  Bucket is now DISABLED");
    } else {
      console.log("✅ Bucket is now ACTIVE");
      console.log(`   Deployers limited to ${afterLimit.toString()} gas`);
      console.log(`   per ${afterDuration.toString()} second window`);
    }
    console.log("");

  } catch (e) {
    console.error("\n❌ Transaction failed:");
    console.error("Error:", e.shortMessage || e.message);
    
    if (e.reason) {
      console.error("Reason:", e.reason);
    }
    
    console.error("\n💡 Possible causes:");
    console.error("   - Function doesn't exist in deployed contract");
    console.error("   - You're not the owner");
    console.error("   - Insufficient gas");
    console.error("   - Invalid parameters");
    process.exit(1);
  }
}

/**
 * Desactiva el bucket (pone límite en 0)
 */
async function disableBucket(hubAddress, wallet) {
  console.log("🚫 DISABLING BUCKET");
  console.log("═".repeat(60));
  console.log("");
  console.log("This will remove all gas limits for deploys");
  console.log("Setting limit to 0 and duration to 0");
  console.log("");

  // Reutilizar la función setBucketConfig con valores 0
  process.argv[3] = "0";
  process.argv[4] = "0";
  
  await setBucketConfig(hubAddress, wallet);
}

/**
 * Muestra ayuda de uso
 */
function printUsage() {
  console.log("Usage: node scripts/admin/manageBuckets.js <command> [options]\n");
  console.log("Commands:\n");
  
  console.log("  info");
  console.log("    Show global bucket configuration");
  console.log("    Example: node scripts/admin/manageBuckets.js info\n");
  
  console.log("  status <deployerAddress>");
  console.log("    Show bucket status for a specific deployer");
  console.log("    Example: node scripts/admin/manageBuckets.js status 0xABCD...\n");
  
  console.log("  set <gasLimit> <durationSeconds>");
  console.log("    Configure the gas bucket limits");
  console.log("    Examples:");
  console.log("      node scripts/admin/manageBuckets.js set 10000000 600    # 10M gas, 10 min");
  console.log("      node scripts/admin/manageBuckets.js set 5000000 300     # 5M gas, 5 min");
  console.log("      node scripts/admin/manageBuckets.js set 20000000 3600   # 20M gas, 1 hour\n");
  
  console.log("  disable");
  console.log("    Disable gas bucket limits (unlimited deploys)");
  console.log("    Example: node scripts/admin/manageBuckets.js disable\n");
  
  console.log("  help");
  console.log("    Show this help message\n");
}

// Ejecutar
main().catch((e) => {
  console.error("\n❌ Unhandled error:");
  console.error(e);
  process.exit(1);
});