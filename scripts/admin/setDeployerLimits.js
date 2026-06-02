/**
 * Admin Script: Set Deployer-Specific Gas Bucket Configuration
 * 
 * This script allows you to:
 * 1. Set custom gas bucket limits for specific deployers
 * 2. Add/remove deployers from the allowlist
 * 3. Batch configure multiple deployers at once
 * 4. View current deployer configurations
 * 
 * Usage:
 *   # Set custom config for a single deployer
 *   node setDeployerLimits.js --deployer <address> --limit <gas> --duration <seconds> --allow
 * 
 *   # Use default config for a deployer
 *   node setDeployerLimits.js --deployer <address> --use-default --allow
 * 
 *   # Just add to allowlist (use default config)
 *   node setDeployerLimits.js --deployer <address> --allow
 * 
 *   # Remove from allowlist
 *   node setDeployerLimits.js --deployer <address> --disallow
 * 
 *   # View deployer info
 *   node setDeployerLimits.js --deployer <address> --info
 * 
 *   # List all deployers
 *   node setDeployerLimits.js --list
 * 
 *   # Batch configure from JSON file
 *   node setDeployerLimits.js --batch deployers.json
 * 
 * Example:
 *   node setDeployerLimits.js --deployer 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb --limit 5000000 --duration 300 --allow
 */
import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (two levels up from scripts/admin/)
const envPath = path.resolve(__dirname, "../../.env");
console.log(`Loading .env from: ${envPath}\n`);
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.error("❌ Error loading .env file:", result.error.message);
  console.error("   Make sure .env exists at project root");
  process.exit(1);
}

// ABI for the MetaTxForwarder contract
const FORWARDER_ABI = [
  "function setAllowedDeployer(address account, bool allowed) external",
  "function setDeployerBucketConfig(address deployer, uint256 limit, uint64 durationSeconds, bool useCustom) external",
  "function setDeployersBucketConfig(address[] calldata deployers, uint256[] calldata limits, uint64[] calldata durations, bool[] calldata useCustoms) external",
  "function setAllowedDeployers(address[] calldata accounts, bool allowed) external",
  "function getDeployerInfo(address deployer) view returns (tuple(address deployer, bool allowed, uint256 gasUsedInWindow, uint64 windowStartedAt, uint256 lastDeployBlock, uint256 gasBucketLimit, uint64 gasBucketDuration, bool useCustomConfig))",
  "function getAllowedDeployers() view returns (address[])",
  "function allowedDeployers(address) view returns (bool)",
  "function defaultDeployGasBucketLimit() view returns (uint256)",
  "function defaultDeployGasBucketDuration() view returns (uint64)",
  "function owner() view returns (address)"
];

async function main() {
  const args = process.argv.slice(2);

  // Configuration from environment variables
  const FORWARDER_ADDRESS = process.env.HUB_ADDRESS;
  const RPC_URL = process.env.RPC_URL;
  const PRIVATE_KEY = process.env.RELAYER_PK;

  if (!FORWARDER_ADDRESS || !RPC_URL || !PRIVATE_KEY) {
    console.error('❌ Missing environment variables. Please set in .env:');
    console.log('   - HUB_ADDRESS (forwarder contract address)');
    console.log('   - RPC_URL (network RPC endpoint)');
    console.log('   - RELAYER_PK (admin private key)');
    process.exit(1);
  }

  // Connect to the network
  console.log('🔗 Connecting to network...');
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const forwarder = new ethers.Contract(FORWARDER_ADDRESS, FORWARDER_ABI, wallet);

  console.log(`📍 Forwarder: ${FORWARDER_ADDRESS}`);
  console.log(`👤 Admin: ${wallet.address}`);
  console.log(`⛓️  Network: Chain ID ${(await provider.getNetwork()).chainId}`);
  console.log(`📦 Block: ${await provider.getBlockNumber()}\n`);

  // Verify ownership
  try {
    const owner = await forwarder.owner();
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.error(`❌ Not the owner! Owner is: ${owner}`);
      console.error(`   Your address: ${wallet.address}`);
      process.exit(1);
    }
    console.log(`✅ Ownership verified\n`);
  } catch (error) {
    console.error(`❌ Failed to verify ownership: ${error.message}`);
    process.exit(1);
  }

  // Setup transaction options based on network
  const txOptions = {};
  if (process.env.NETWORK === "LNET") {
    txOptions.gasPrice = 0n;
    txOptions.type = 0;
    txOptions.gasLimit = 4_000_000n;
    console.log(`⚙️  Using LNET tx options (gasPrice: 0, gasLimit: 4M)\n`);
  }

  // Parse command line arguments
  if (args.includes('--batch')) {
    await handleBatch(args, forwarder, txOptions);
  } else if (args.includes('--deployer')) {
    await handleSingleDeployer(args, forwarder, txOptions);
  } else if (args.includes('--list')) {
    await listAllDeployers(forwarder);
  } else {
    showUsage();
  }
}

async function handleSingleDeployer(args, forwarder, txOptions) {
  const deployerIndex = args.indexOf('--deployer');
  const deployer = args[deployerIndex + 1];

  if (!deployer) {
    console.error('❌ No deployer address provided');
    process.exit(1);
  }

  // Validate and normalize address
  let normalizedDeployer;
  try {
    normalizedDeployer = ethers.getAddress(deployer);
  } catch (e) {
    console.error(`❌ Invalid deployer address: ${deployer}`);
    process.exit(1);
  }

  // Check if user just wants info
  if (args.includes('--info')) {
    await showDeployerInfo(normalizedDeployer, forwarder);
    return;
  }

  const limitIndex = args.indexOf('--limit');
  const durationIndex = args.indexOf('--duration');
  const allow = args.includes('--allow');
  const disallow = args.includes('--disallow');
  const useDefault = args.includes('--use-default');

  console.log(`\n🎯 Configuring deployer: ${normalizedDeployer}`);

  // Show current info
  console.log('\n📊 Current Configuration:');
  await showDeployerInfo(normalizedDeployer, forwarder);

  try {
    // Handle allowlist change
    if (allow || disallow) {
      console.log(`\n${allow ? '✅' : '❌'} ${allow ? 'Adding to' : 'Removing from'} allowlist...`);
      const tx1 = await forwarder.setAllowedDeployer(normalizedDeployer, allow, txOptions);
      console.log(`📤 Transaction sent: ${tx1.hash}`);
      const receipt1 = await tx1.wait();
      console.log(`✅ Allowlist updated (gas used: ${receipt1.gasUsed.toString()})`);
    }

    // Handle bucket configuration
    if (limitIndex !== -1 && durationIndex !== -1) {
      const limit = args[limitIndex + 1];
      const duration = args[durationIndex + 1];

      if (!limit || !duration) {
        console.error('❌ Invalid limit or duration');
        process.exit(1);
      }

      // Validate numbers
      if (isNaN(limit) || isNaN(duration)) {
        console.error('❌ Limit and duration must be numbers');
        process.exit(1);
      }

      console.log(`\n⚙️  Setting custom bucket config...`);
      console.log(`   Limit: ${limit} gas`);
      console.log(`   Duration: ${duration} seconds`);
      
      const tx2 = await forwarder.setDeployerBucketConfig(
        normalizedDeployer, 
        limit, 
        duration, 
        true, 
        txOptions
      );
      console.log(`📤 Transaction sent: ${tx2.hash}`);
      const receipt2 = await tx2.wait();
      console.log(`✅ Bucket config updated (gas used: ${receipt2.gasUsed.toString()})`);

    } else if (useDefault) {
      console.log(`\n⚙️  Setting to use default bucket config...`);
      const tx2 = await forwarder.setDeployerBucketConfig(
        normalizedDeployer, 
        0, 
        0, 
        false, 
        txOptions
      );
      console.log(`📤 Transaction sent: ${tx2.hash}`);
      const receipt2 = await tx2.wait();
      console.log(`✅ Now using default config (gas used: ${receipt2.gasUsed.toString()})`);
    }

    // Show updated info
    console.log('\n📊 Updated Configuration:');
    await showDeployerInfo(normalizedDeployer, forwarder);

  } catch (error) {
    console.error('\n❌ Transaction failed:', error.message);
    if (error.shortMessage) {
      console.error('Short message:', error.shortMessage);
    }
    if (error.data) {
      console.error('Error data:', error.data);
    }
    process.exit(1);
  }
}

async function handleBatch(args, forwarder, txOptions) {
  const batchIndex = args.indexOf('--batch');
  const filename = args[batchIndex + 1];

  if (!filename) {
    console.error('❌ No batch file specified');
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), filename);
  
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  let batchData;
  try {
    batchData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error(`❌ Failed to parse JSON file: ${e.message}`);
    process.exit(1);
  }

  if (!batchData.deployers || !Array.isArray(batchData.deployers)) {
    console.error('❌ Invalid batch file format. Expected { "deployers": [...] }');
    process.exit(1);
  }

  console.log(`\n📦 Processing batch configuration from ${filename}`);
  console.log(`   Total deployers: ${batchData.deployers.length}`);

  // Validate all addresses first
  const normalizedAddresses = [];
  for (const item of batchData.deployers) {
    try {
      const normalized = ethers.getAddress(item.address);
      normalizedAddresses.push(normalized);
    } catch (e) {
      console.error(`❌ Invalid address: ${item.address}`);
      process.exit(1);
    }
  }

  try {
    // Prepare arrays for batch operations
    const addresses = [];
    const limits = [];
    const durations = [];
    const useCustoms = [];
    const allowAddresses = [];

    for (let i = 0; i < batchData.deployers.length; i++) {
      const item = batchData.deployers[i];
      const normalized = normalizedAddresses[i];
      
      addresses.push(normalized);
      
      if (item.useDefault) {
        limits.push(0);
        durations.push(0);
        useCustoms.push(false);
      } else {
        limits.push(item.limit || 0);
        durations.push(item.duration || 0);
        useCustoms.push(true);
      }

      if (item.allow) {
        allowAddresses.push(normalized);
      }
    }

    // Set bucket configs
    console.log('\n⚙️  Setting bucket configurations...');
    const tx1 = await forwarder.setDeployersBucketConfig(
      addresses, 
      limits, 
      durations, 
      useCustoms, 
      txOptions
    );
    console.log(`📤 Transaction sent: ${tx1.hash}`);
    const receipt1 = await tx1.wait();
    console.log(`✅ Bucket configs set (gas used: ${receipt1.gasUsed.toString()})`);

    // Set allowlist
    if (allowAddresses.length > 0) {
      console.log(`\n✅ Adding ${allowAddresses.length} deployers to allowlist...`);
      const tx2 = await forwarder.setAllowedDeployers(allowAddresses, true, txOptions);
      console.log(`📤 Transaction sent: ${tx2.hash}`);
      const receipt2 = await tx2.wait();
      console.log(`✅ Allowlist updated (gas used: ${receipt2.gasUsed.toString()})`);
    }

    console.log('\n✨ Batch configuration complete!');

    // Show summary
    console.log('\n📊 Summary (first 5):');
    for (const addr of addresses.slice(0, 5)) {
      await showDeployerInfo(addr, forwarder);
    }
    if (addresses.length > 5) {
      console.log(`\n   ... and ${addresses.length - 5} more deployers`);
    }

  } catch (error) {
    console.error('\n❌ Batch operation failed:', error.message);
    if (error.shortMessage) {
      console.error('Short message:', error.shortMessage);
    }
    if (error.data) {
      console.error('Error data:', error.data);
    }
    process.exit(1);
  }
}

async function showDeployerInfo(deployer, forwarder) {
  try {
    const info = await forwarder.getDeployerInfo(deployer);
    const defaultLimit = await forwarder.defaultDeployGasBucketLimit();
    const defaultDuration = await forwarder.defaultDeployGasBucketDuration();

    console.log(`\n   📋 Deployer: ${deployer}`);
    console.log(`      Allowed: ${info.allowed ? '✅ YES' : '❌ NO'}`);
    console.log(`      Config: ${info.useCustomConfig ? '🔧 Custom' : '📦 Default'}`);
    
    if (info.useCustomConfig) {
      console.log(`      Gas Limit: ${info.gasBucketLimit.toString()}`);
      console.log(`      Duration: ${info.gasBucketDuration.toString()}s`);
    } else {
      console.log(`      Gas Limit: ${defaultLimit.toString()} (default)`);
      console.log(`      Duration: ${defaultDuration.toString()}s (default)`);
    }
    
    console.log(`      Gas Used in Window: ${info.gasUsedInWindow.toString()}`);
    
    if (info.windowStartedAt > 0) {
      const startedAt = new Date(Number(info.windowStartedAt) * 1000);
      console.log(`      Window Started: ${startedAt.toLocaleString()}`);
    } else {
      console.log(`      Window Started: Not started`);
    }
    
    console.log(`      Last Deploy Block: ${info.lastDeployBlock.toString() === '0' ? 'Never' : info.lastDeployBlock.toString()}`);
    
  } catch (error) {
    console.error(`      ❌ Failed to fetch info: ${error.message}`);
  }
}

async function listAllDeployers(forwarder) {
  console.log('\n📋 All Allowed Deployers:\n');
  try {
    const deployers = await forwarder.getAllowedDeployers();
    
    if (deployers.length === 0) {
      console.log('   (no deployers configured yet)');
      return;
    }

    for (const deployer of deployers) {
      await showDeployerInfo(deployer, forwarder);
    }
    
    console.log(`\n✨ Total: ${deployers.length} deployer${deployers.length === 1 ? '' : 's'}`);
  } catch (error) {
    console.error('❌ Failed to list deployers:', error.message);
    process.exit(1);
  }
}

function showUsage() {
  console.log('\n📖 Usage:\n');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('Single deployer configuration:\n');
  console.log('  node setDeployerLimits.js --deployer <address> --limit <gas> --duration <seconds> --allow');
  console.log('  node setDeployerLimits.js --deployer <address> --use-default --allow');
  console.log('  node setDeployerLimits.js --deployer <address> --allow');
  console.log('  node setDeployerLimits.js --deployer <address> --disallow');
  console.log('  node setDeployerLimits.js --deployer <address> --info');
  console.log('\nBatch configuration:\n');
  console.log('  node setDeployerLimits.js --batch deployers.json');
  console.log('\nList all deployers:\n');
  console.log('  node setDeployerLimits.js --list');
  console.log('\n═══════════════════════════════════════════════════════════\n');
  console.log('Examples:\n');
  console.log('  # Set custom limits and allow deployer');
  console.log('  node setDeployerLimits.js --deployer 0x123... --limit 5000000 --duration 300 --allow\n');
  console.log('  # Use default config and allow deployer');
  console.log('  node setDeployerLimits.js --deployer 0x456... --use-default --allow\n');
  console.log('  # Just allow deployer (uses default config)');
  console.log('  node setDeployerLimits.js --deployer 0x789... --allow\n');
  console.log('  # View deployer info');
  console.log('  node setDeployerLimits.js --deployer 0xabc... --info\n');
  console.log('  # List all deployers');
  console.log('  node setDeployerLimits.js --list\n');
  console.log('\n═══════════════════════════════════════════════════════════\n');
  console.log('Batch JSON format (deployers.json):\n');
  console.log('{');
  console.log('  "deployers": [');
  console.log('    {');
  console.log('      "address": "0x123...",');
  console.log('      "limit": 5000000,');
  console.log('      "duration": 300,');
  console.log('      "allow": true');
  console.log('    },');
  console.log('    {');
  console.log('      "address": "0x456...",');
  console.log('      "useDefault": true,');
  console.log('      "allow": true');
  console.log('    }');
  console.log('  ]');
  console.log('}\n');
}

main()
  .then(() => {
    console.log('\n✅ Script completed successfully\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:');
    console.error(error);
    process.exit(1);
  });