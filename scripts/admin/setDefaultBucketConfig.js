/**
 * Admin Script: Set Default Deploy Gas Bucket Configuration
 * 
 * This script sets the global fallback configuration for deploy gas buckets.
 * This config will be used for all deployers unless they have a custom configuration.
 * 
 * Usage:
 *   node setDefaultBucketConfig.js --limit <gas_limit> --duration <seconds>
 * 
 * Example:
 *   node setDefaultBucketConfig.js --limit 10000000 --duration 600
 *   (Sets 10M gas limit over 600 seconds / 10 minutes)
 */

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const RPC_URL = process.env.RPC_URL;
const RELAYER_PK = process.env.RELAYER_PK;
const HUB_ADDRESS = process.env.HUB_ADDRESS;


// ABI for the MetaTxForwarder contract (only the functions we need)
const FORWARDER_ABI = [
  "function setDefaultDeployGasBucketConfig(uint256 limit, uint64 durationSeconds) external",
  "function defaultDeployGasBucketLimit() view returns (uint256)",
  "function defaultDeployGasBucketDuration() view returns (uint64)",
  "function owner() view returns (address)"
];

async function main() {
 console.log('rpc url:', RPC_URL);
 console.log('relayer pk:', RELAYER_PK);
 console.log('hub address', HUB_ADDRESS);


    // Parse command line arguments
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf('--limit');
  const durationIndex = args.indexOf('--duration');
  
  if (limitIndex === -1 || durationIndex === -1) {
    console.error('❌ Missing required arguments');
    console.log('\nUsage:');
    console.log('  node setDefaultBucketConfig.js --limit <gas_limit> --duration <seconds>');
    console.log('\nExample:');
    console.log('  node setDefaultBucketConfig.js --limit 10000000 --duration 600');
    console.log('\nNote: Use 0 for no limit/duration');
    process.exit(1);
  }

  const limit = args[limitIndex + 1];
  const duration = args[durationIndex + 1];

  if (!limit || !duration) {
    console.error('❌ Invalid arguments provided');
    process.exit(1);
  }

  // Configuration
  const FORWARDER_ADDRESS = HUB_ADDRESS;
  const PRIVATE_KEY = RELAYER_PK;


  if (!FORWARDER_ADDRESS || !RPC_URL || !PRIVATE_KEY) {
    console.error('❌ Missing environment variables. Please set:');
    console.log('   - HUB_ADDRESS');
    console.log('   - RPC_URL');
    console.log('   - RELAYER_PK');
    process.exit(1);
  }

  // Connect to the network
  console.log('🔗 Connecting to network...');
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const forwarder = new ethers.Contract(FORWARDER_ADDRESS, FORWARDER_ABI, wallet);

  console.log(`📍 Forwarder Hub Address: ${FORWARDER_ADDRESS}`);
  console.log(`👤 Admin: ${wallet.address}`);

  // Verify ownership
  const owner = await forwarder.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`❌ Not the owner! Owner is: ${owner}`);
    process.exit(1);
  }

  // Get current configuration
  console.log('\n📊 Current Configuration:');
  const currentLimit = await forwarder.defaultDeployGasBucketLimit();
  const currentDuration = await forwarder.defaultDeployGasBucketDuration();
  console.log(`   Limit: ${currentLimit.toString()} gas`);
  console.log(`   Duration: ${currentDuration.toString()} seconds`);

  // Display new configuration
  console.log('\n🆕 New Configuration:');
  console.log(`   Limit: ${limit} gas ${limit === '0' ? '(no limit)' : ''}`);
  console.log(`   Duration: ${duration} seconds ${duration === '0' ? '(no expiration)' : ''}`);

  // Confirm
  console.log('\n⏳ Setting default bucket config...');
  
  try {

    let tx = null;
    let txOptions = {};
  
    if (process.env.NETWORK === "LNET") {

        txOptions = { 
        gasPrice: 0, 
        type: 0,
        gasLimit: 4_000_000n
        }
    };
    tx = await forwarder.setDefaultDeployGasBucketConfig(limit, duration, txOptions);
    console.log(`📤 Transaction sent: ${tx.hash}`);
    
    const receipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
    console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`);

    // Verify the change
    const newLimit = await forwarder.defaultDeployGasBucketLimit();
    const newDuration = await forwarder.defaultDeployGasBucketDuration();
    
    console.log('\n✨ Updated Configuration:');
    console.log(`   Limit: ${newLimit.toString()} gas`);
    console.log(`   Duration: ${newDuration.toString()} seconds`);

  } catch (error) {
    console.error('\n❌ Transaction failed:', error.message);
    if (error.data) {
      console.error('Error data:', error.data);
    }
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });