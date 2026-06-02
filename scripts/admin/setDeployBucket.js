import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Get the directory name in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (two levels up from scripts/admin/)
const envPath = path.resolve(__dirname, "../../.env");
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.error(JSON.stringify({ error: "Failed to load .env file", message: result.error.message }));
  process.exit(1);
}

/**
 * Script para administrar la configuración del bucket de gas para deploys
 * 
 * Uso:
 *   node setDeployGasBucketConfig.js                          # Ver config actual
 *   node setDeployGasBucketConfig.js <limit> <duration>      # Setear nueva config
 *   node setDeployGasBucketConfig.js 20000000 1200          # 20M gas, 20 minutos
 *   node setDeployGasBucketConfig.js --disable               # Deshabilitar límites
 */

function log(message) {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    return { mode: 'view' };
  }
  
  if (args[0] === '--disable' || args[0] === '-d') {
    return { mode: 'disable' };
  }
  
  if (args[0] === '--help' || args[0] === '-h') {
    return { mode: 'help' };
  }
  
  if (args.length === 2) {
    const limit = args[0];
    const duration = args[1];
    
    // Validar que sean números
    if (!/^\d+$/.test(limit) || !/^\d+$/.test(duration)) {
      return { mode: 'error', error: 'Limit and duration must be positive integers' };
    }
    
    return { 
      mode: 'set',
      limit: limit,
      duration: duration
    };
  }
  
  return { mode: 'error', error: 'Invalid arguments. Use --help for usage information.' };
}

function showHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║              Deploy Gas Bucket Configuration Manager                      ║
╚════════════════════════════════════════════════════════════════════════════╝

USAGE:
  node setDeployGasBucketConfig.js [options]

MODES:
  (no args)                    View current configuration (via events)
  <limit> <duration>           Set new configuration
  --disable, -d                Disable limits (set both to 0)
  --help, -h                   Show this help

ARGUMENTS:
  limit                        Gas limit for deploy bucket (in gas units)
  duration                     Duration of the bucket window (in seconds)

EXAMPLES:
  # View current config
  node setDeployGasBucketConfig.js

  # Set 5M gas limit with 5 minute window
  node setDeployGasBucketConfig.js 5000000 300

  # Set 10M gas limit with 10 minute window
  node setDeployGasBucketConfig.js 10000000 600

  # Set 20M gas limit with 20 minute window
  node setDeployGasBucketConfig.js 20000000 1200

  # Set 50M gas limit with 1 hour window
  node setDeployGasBucketConfig.js 50000000 3600

  # Disable limits (unlimited deploys)
  node setDeployGasBucketConfig.js --disable

NOTES:
  - Limit is in gas units (e.g., 10000000 = 10M gas)
  - Duration is in seconds (e.g., 600 = 10 minutes)
  - Setting limit=0 or duration=0 disables the bucket system
  - Each deployer has their own independent bucket
  - Buckets refill after the duration expires

COMMON CONFIGURATIONS:
  Light usage:    5000000 gas,  300 seconds (5 min)
  Medium usage:  10000000 gas,  600 seconds (10 min)
  Heavy usage:   20000000 gas, 1200 seconds (20 min)
  Very heavy:    50000000 gas, 3600 seconds (1 hour)
  Unlimited:            0 gas,    0 seconds (disabled)
`);
}

async function getCurrentConfigFromEvents(contract, provider) {
  log("Fetching current configuration from events...");
  
  try {
    const filter = contract.filters.DeployGasBucketConfigSet();
    const currentBlock = await provider.getBlockNumber();
    
    // Buscar en los últimos 10k bloques
    const fromBlock = Math.max(0, currentBlock - 10000);
    log(`Scanning events from block ${fromBlock} to ${currentBlock}...`);
    
    const events = await contract.queryFilter(filter, fromBlock, currentBlock);
    
    if (events.length === 0) {
      log("No DeployGasBucketConfigSet events found in recent blocks");
      return {
        limit: "unknown",
        duration: "unknown",
        enabled: null,
        source: "no-events"
      };
    }
    
    // Tomar el evento más reciente
    const lastEvent = events[events.length - 1];
    const limit = lastEvent.args.limit;
    const duration = lastEvent.args.durationSeconds;
    
    log(`Found config in block ${lastEvent.blockNumber}`);
    
    return {
      limit: limit.toString(),
      duration: duration.toString(),
      durationMinutes: (Number(duration) / 60).toFixed(2),
      durationHours: (Number(duration) / 3600).toFixed(2),
      limitFormatted: formatGas(limit),
      enabled: limit > 0 && duration > 0,
      source: "events",
      blockNumber: lastEvent.blockNumber,
      transactionHash: lastEvent.transactionHash
    };
  } catch (e) {
    log(`Error fetching events: ${e.message}`);
    return {
      limit: "error",
      duration: "error",
      enabled: null,
      source: "error",
      error: e.message
    };
  }
}

function formatGas(gas) {
  const num = Number(gas);
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(2)}M`;
  } else if (num >= 1_000) {
    return `${(num / 1_000).toFixed(2)}K`;
  } else {
    return num.toString();
  }
}

function formatDuration(seconds) {
  const num = Number(seconds);
  if (num >= 3600) {
    const hours = num / 3600;
    return `${hours.toFixed(2)} hour${hours !== 1 ? 's' : ''}`;
  } else if (num >= 60) {
    const minutes = num / 60;
    return `${minutes.toFixed(2)} minute${minutes !== 1 ? 's' : ''}`;
  } else {
    return `${num} second${num !== 1 ? 's' : ''}`;
  }
}

async function main() {
  const args = parseArgs();
  
  if (args.mode === 'help') {
    showHelp();
    process.exit(0);
  }
  
  if (args.mode === 'error') {
    console.error(`Error: ${args.error}`);
    console.error('Use --help for usage information.');
    process.exit(1);
  }
  
  const resultData = {
    timestamp: new Date().toISOString(),
    mode: args.mode,
    success: false,
    config: {},
    transaction: null,
    error: null
  };

  try {
    const rpc = process.env.RPC_URL;
    const relayerPk = process.env.RELAYER_PK;
    const hubAddress = process.env.HUB_ADDRESS;

    if (!rpc || !relayerPk || !hubAddress) {
      resultData.error = "Missing required environment variables (RPC_URL, RELAYER_PK, HUB_ADDRESS)";
      console.log(JSON.stringify(resultData, null, 2));
      process.exit(1);
    }

    log("Connecting to network...");
    const provider = new ethers.JsonRpcProvider(rpc);
    const wallet = new ethers.Wallet(relayerPk, provider);
    const metaAddr = ethers.getAddress(hubAddress);
    
    log(`Contract: ${metaAddr}`);
    log(`Wallet: ${wallet.address}`);

    const network = await provider.getNetwork();
    log(`Network: ${network.name} (${network.chainId})`);

    const abi = [
      "function setDeployGasBucketConfig(uint256 limit, uint64 durationSeconds) external",
      "function owner() view returns (address)",
      "event DeployGasBucketConfigSet(uint256 limit, uint64 durationSeconds)"
    ];
    
    const contract = new ethers.Contract(metaAddr, abi, wallet);

    // Verificar ownership
    log("Checking ownership...");
    try {
      const owner = await contract.owner();
      if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
        resultData.error = `Wallet ${wallet.address} is not the owner (owner is ${owner})`;
        console.log(JSON.stringify(resultData, null, 2));
        process.exit(1);
      }
      log("✓ Wallet is the owner");
    } catch (e) {
      log("Warning: Could not verify ownership");
    }

    // Get current config from events
    const currentConfig = await getCurrentConfigFromEvents(contract, provider);
    resultData.config.current = currentConfig;
    
    if (args.mode === 'view') {
      log("\n=== CURRENT CONFIGURATION ===");
      
      if (currentConfig.source === "events") {
        log(`Gas Limit:    ${currentConfig.limitFormatted} (${currentConfig.limit} gas)`);
        log(`Duration:     ${formatDuration(currentConfig.duration)} (${currentConfig.duration}s)`);
        log(`Status:       ${currentConfig.enabled ? '✓ ENABLED' : '✗ DISABLED'}`);
        log(`Source:       Event in block ${currentConfig.blockNumber}`);
        
        if (currentConfig.enabled) {
          log(`\nThis means each deployer can use up to ${currentConfig.limitFormatted} gas`);
          log(`within a ${formatDuration(currentConfig.duration)} window.`);
        } else {
          log('\nThe bucket system is DISABLED (no gas limits for deploys)');
        }
      } else if (currentConfig.source === "no-events") {
        log("No configuration found in recent events.");
        log("The contract may be using default values or was configured before the scanned blocks.");
      } else {
        log(`Error retrieving configuration: ${currentConfig.error}`);
      }
      
      resultData.success = true;
      console.log(JSON.stringify(resultData, null, 2));
      process.exit(0);
    }

    // Set new config
    let newLimit, newDuration;
    
    if (args.mode === 'disable') {
      newLimit = "0";
      newDuration = "0";
      log("\n=== DISABLING BUCKET SYSTEM ===");
    } else {
      newLimit = args.limit;
      newDuration = args.duration;
      log("\n=== SETTING NEW CONFIGURATION ===");
    }
    
    resultData.config.new = {
      limit: newLimit,
      duration: newDuration,
      limitFormatted: formatGas(newLimit),
      durationFormatted: formatDuration(newDuration),
      enabled: newLimit !== "0" && newDuration !== "0"
    };
    
    log(`New Gas Limit:    ${resultData.config.new.limitFormatted} (${newLimit} gas)`);
    log(`New Duration:     ${resultData.config.new.durationFormatted} (${newDuration}s)`);
    log(`Status:           ${resultData.config.new.enabled ? '✓ ENABLED' : '✗ DISABLED'}`);
    
    // Show comparison if we have current config
    if (currentConfig.source === "events") {
      log("\n=== CHANGES ===");
      log(`Gas Limit:    ${currentConfig.limitFormatted} → ${resultData.config.new.limitFormatted}`);
      log(`Duration:     ${formatDuration(currentConfig.duration)} → ${resultData.config.new.durationFormatted}`);
    }
    
   

    // Execute transaction
    log("\nSending transaction...");
    const tx = await contract.setDeployGasBucketConfig(newLimit, newDuration);
    log(`Transaction hash: ${tx.hash}`);
    
    resultData.transaction = {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      gasLimit: tx.gasLimit?.toString(),
      gasPrice: 0
    };
    
    log("Waiting for confirmation...");
    const receipt = await tx.wait();
    log(`✓ Transaction confirmed in block ${receipt.blockNumber}`);
    
    resultData.transaction.blockNumber = receipt.blockNumber;
    resultData.transaction.gasUsed = receipt.gasUsed.toString();
    resultData.transaction.status = receipt.status === 1 ? "success" : "failed";
    
    if (receipt.status === 1) {
      log("\n=== SUCCESS ===");
      log("Deploy gas bucket configuration updated successfully!");
      resultData.success = true;
      
      // Verify new config from event in receipt
      log("\nVerifying new configuration from transaction event...");
      const configEvent = receipt.logs.find(log => {
        try {
          const parsed = contract.interface.parseLog(log);
          return parsed?.name === "DeployGasBucketConfigSet";
        } catch {
          return false;
        }
      });
      
      if (configEvent) {
        const parsed = contract.interface.parseLog(configEvent);
        const verifiedLimit = parsed.args.limit.toString();
        const verifiedDuration = parsed.args.durationSeconds.toString();
        
        resultData.config.verified = {
          limit: verifiedLimit,
          duration: verifiedDuration,
          limitFormatted: formatGas(verifiedLimit),
          durationFormatted: formatDuration(verifiedDuration),
          enabled: verifiedLimit !== "0" && verifiedDuration !== "0"
        };
        
        if (verifiedLimit === newLimit && verifiedDuration === newDuration) {
          log("✓ Configuration verified from transaction event");
          log(`  Gas Limit: ${formatGas(verifiedLimit)}`);
          log(`  Duration:  ${formatDuration(verifiedDuration)}`);
        } else {
          log("⚠ Warning: Event values don't match expected values");
          log(`  Expected: ${newLimit} gas, ${newDuration}s`);
          log(`  Got:      ${verifiedLimit} gas, ${verifiedDuration}s`);
        }
      } else {
        log("⚠ Could not find DeployGasBucketConfigSet event in transaction");
      }
    } else {
      resultData.error = "Transaction failed";
      log("\n=== FAILED ===");
      log("Transaction failed!");
    }

    console.log(JSON.stringify(resultData, null, 2));
    process.exit(receipt.status === 1 ? 0 : 1);

  } catch (e) {
    resultData.error = e.message;
    resultData.errorStack = e.stack;
    log(`\nError: ${e.message}`);
    
    // Try to parse revert reason
    if (e.data) {
      log(`Error data: ${e.data}`);
    }
    if (e.reason) {
      log(`Reason: ${e.reason}`);
    }
    
    console.log(JSON.stringify(resultData, null, 2));
    process.exit(1);
  }
}

main().catch((e) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    mode: 'unknown',
    success: false,
    config: {},
    transaction: null,
    error: e.message,
    errorStack: e.stack
  }, null, 2));
  process.exit(1);
});