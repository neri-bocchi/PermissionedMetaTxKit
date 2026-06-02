import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.resolve(__dirname, "../../.env");
console.log(`Loading .env from: ${envPath}\n`);
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.error("❌ Error loading .env file:", result.error.message);
  process.exit(1);
}

const requiredVars = ["RPC_URL", "RELAYER_PK", "HUB_ADDRESS"];
const missing = requiredVars.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

/**
 * Universal MetaTxForwarder Diagnostic
 * Works with both old and new contract versions
 */

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     Universal MetaTxForwarder Diagnostic Tool             ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(process.env.RELAYER_PK, provider);
  const contractAddr = ethers.getAddress(process.env.HUB_ADDRESS);

  console.log("📋 Configuration:");
  console.log(`   Contract:     ${contractAddr}`);
  console.log(`   Wallet:       ${wallet.address}`);
  console.log(`   Network:      Chain ID ${(await provider.getNetwork()).chainId}`);
  console.log(`   Block:        ${await provider.getBlockNumber()}`);
  console.log(`   Balance:      ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH\n`);

  // Detect contract version
  console.log("🔍 Detecting contract version...\n");
  
  let contractVersion = "unknown";
  let hasCustomBuckets = false;
  
  // Try new version functions first
  try {
    const newVersionAbi = ["function defaultDeployGasBucketLimit() view returns (uint256)"];
    const testContract = new ethers.Contract(contractAddr, newVersionAbi, provider);
    await testContract.defaultDeployGasBucketLimit();
    contractVersion = "v2 (Custom Buckets)";
    hasCustomBuckets = true;
    console.log(`   ✅ Contract Version: ${contractVersion}\n`);
  } catch (e) {
    // Try old version
    try {
      const oldVersionAbi = ["function deployGasBucketLimit() view returns (uint256)"];
      const testContract = new ethers.Contract(contractAddr, oldVersionAbi, provider);
      await testContract.deployGasBucketLimit();
      contractVersion = "v1 (Global Buckets)";
      console.log(`   ✅ Contract Version: ${contractVersion}\n`);
    } catch (e2) {
      console.log(`   ⚠️  Contract Version: Unknown (config getters not available)\n`);
    }
  }

  // Full ABI (union of both versions)
  const abi = [
    // Owner
    "function owner() view returns (address)",
    
    // Callers
    "function isCallerAllowed(address) view returns (bool)",
    "function getAllowedCallers() view returns (address[])",
    "function gasLimitPerBlock(address) view returns (uint256)",
    "function gasUsedThisBlock(address caller) view returns (uint256 used, uint256 limit, uint256 blockNo)",
    
    // Deployers
    "function setAllowedDeployer(address account, bool allowed) external",
    "function setAllowedDeployers(address[] calldata accounts, bool allowed) external",
    "function allowedDeployers(address) view returns (bool)",
    "function getAllowedDeployers() view returns (address[])",
    
    // V1 functions (old version)
    "function getDeployerInfo(address) view returns (tuple(address deployer, bool allowed, uint256 gasUsedInWindow, uint64 windowStartedAt, uint256 lastDeployBlock))",
    "function deployGasBucketLimit() view returns (uint256)",
    "function deployGasBucketDuration() view returns (uint64)",
    
    // V2 functions (new version with custom buckets)
    "function getDeployerInfo(address) view returns (tuple(address deployer, bool allowed, uint256 gasUsedInWindow, uint64 windowStartedAt, uint256 lastDeployBlock, uint256 gasBucketLimit, uint64 gasBucketDuration, bool useCustomConfig))",
    "function defaultDeployGasBucketLimit() view returns (uint256)",
    "function defaultDeployGasBucketDuration() view returns (uint64)",
    "function getDeployerBucketConfig(address) view returns (uint256 limit, uint64 duration, bool useCustom)",
    "function setDeployerBucketConfig(address deployer, uint256 limit, uint64 durationSeconds, bool useCustom) external",
    
    // Common config
    "function gasAccountingOverhead() view returns (uint256)",
    "function erc2771AppendSender() view returns (bool)"
  ];

  const contract = new ethers.Contract(contractAddr, abi, provider);
  const contractWrite = new ethers.Contract(contractAddr, abi, wallet);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("1️⃣  OWNERSHIP");
  console.log("═══════════════════════════════════════════════════════════\n");

  try {
    const owner = await contract.owner();
    const isOwner = owner.toLowerCase() === wallet.address.toLowerCase();
    
    console.log(`   Contract Owner:  ${owner}`);
    console.log(`   Your Address:    ${wallet.address}`);
    console.log(`   Are you owner?   ${isOwner ? "✅ YES" : "❌ NO"}\n`);
    
    if (!isOwner) {
      console.log("   ⚠️  You are NOT the owner!\n");
    }
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}\n`);
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("2️⃣  ALLOWED CALLERS");
  console.log("═══════════════════════════════════════════════════════════\n");

  try {
    const callers = await contract.getAllowedCallers();
    console.log(`   Total: ${callers.length}\n`);
    
    for (const caller of callers) {
      const gasLimit = await contract.gasLimitPerBlock(caller);
      console.log(`   📍 ${caller}`);
      console.log(`      Gas limit: ${gasLimit.toString()}\n`);
    }
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}\n`);
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("3️⃣  ALLOWED DEPLOYERS");
  console.log("═══════════════════════════════════════════════════════════\n");

  try {
    const deployers = await contract.getAllowedDeployers();
    console.log(`   Total: ${deployers.length}\n`);
    
    for (const deployer of deployers) {
        try {
            const info = await contract.getDeployerInfo(deployer);
            const defaultLimit = await contract.defaultDeployGasBucketLimit();
            const defaultDuration = await contract.defaultDeployGasBucketDuration();

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
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}\n`);
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("4️⃣  CONTRACT CONFIGURATION");
  console.log("═══════════════════════════════════════════════════════════\n");

  try {
    const overhead = await contract.gasAccountingOverhead();
    console.log(`   Gas Accounting Overhead:   ${overhead.toString()}`);
  } catch (e) {
    console.log(`   Gas Accounting Overhead:   ❌ Not readable`);
  }

  try {
    const append = await contract.erc2771AppendSender();
    console.log(`   ERC-2771 Append Sender:    ${append}`);
  } catch (e) {
    console.log(`   ERC-2771 Append Sender:    ❌ Not readable`);
  }

  console.log("");

  if (hasCustomBuckets) {
    // V2: Show default config
    try {
      const limit = await contract.defaultDeployGasBucketLimit();
      const duration = await contract.defaultDeployGasBucketDuration();
      console.log(`   📦 DEFAULT Deploy Bucket Config:`);
      console.log(`      Limit:    ${limit.toString()} gas`);
      console.log(`      Duration: ${duration.toString()} seconds\n`);
    } catch (e) {
      console.log(`   Default Deploy Bucket: ❌ Not readable\n`);
    }
  } else {
    // V1: Show global config
    console.log(`   📦 GLOBAL Deploy Bucket Config:`);
    console.log(`      (Used by all deployers)\n`);
    
    // These functions are failing in your deployed contract
    console.log(`      Limit:    ⚠️  Not publicly readable`);
    console.log(`      Duration: ⚠️  Not publicly readable`);
    console.log(`      (Variables exist but don't have public getters)\n`);
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("5️⃣  TESTING WRITE FUNCTIONS");
  console.log("═══════════════════════════════════════════════════════════\n");

  const testAddr = process.argv[2] || "0x1234567890123456789012345678901234567890";
  console.log(`   Testing with: ${testAddr}\n`);

  try {
    const validAddr = ethers.getAddress(testAddr);
    
    // Test setAllowedDeployer
    console.log("   Testing: setAllowedDeployer(address, bool)");
    try {
      const gas = await contractWrite.setAllowedDeployer.estimateGas(validAddr, true);
      console.log(`   ✅ Would succeed! Gas: ${gas.toString()}\n`);
    } catch (e) {
      console.log(`   ❌ Would fail: ${e.shortMessage || e.message}\n`);
    }

    if (hasCustomBuckets) {
      // Test V2 function
      console.log("   Testing: setDeployerBucketConfig(address, uint256, uint64, bool)");
      try {
        const gas = await contractWrite.setDeployerBucketConfig.estimateGas(
          validAddr, 
          20_000_000, // 20M gas limit
          1200,       // 20 minutes
          true        // use custom
        );
        console.log(`   ✅ Would succeed! Gas: ${gas.toString()}\n`);
      } catch (e) {
        console.log(`   ❌ Would fail: ${e.shortMessage || e.message}\n`);
      }
    }
  } catch (e) {
    console.log(`   ❌ Invalid address\n`);
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("6️⃣  SUMMARY & RECOMMENDATIONS");
  console.log("═══════════════════════════════════════════════════════════\n");

  console.log(`   Contract Version: ${contractVersion}`);
  
  if (contractVersion === "v1 (Global Buckets)") {
    console.log(`   \n   📝 Your deployed contract is V1:`);
    console.log(`      • Uses GLOBAL deploy bucket config for all deployers`);
    console.log(`      • Config variables exist but have no public getters`);
    console.log(`      • To read config: check deployment tx or events`);
    console.log(`      • To upgrade: deploy new V2 contract with custom buckets\n`);
  } else if (contractVersion === "v2 (Custom Buckets)") {
    console.log(`   \n   📝 Your deployed contract is V2:`);
    console.log(`      • Supports CUSTOM deploy bucket config per deployer`);
    console.log(`      • Has default config that applies when custom not set`);
    console.log(`      • Use setDeployerBucketConfig() for custom limits\n`);
  } else {
    console.log(`   \n   ⚠️  Could not determine contract version`);
    console.log(`      • Check if contract is verified on block explorer`);
    console.log(`      • Compare deployed bytecode with your source\n`);
  }

  console.log(`   🔗 View on explorer:`);
  console.log(`      https://basescan.org/address/${contractAddr}\n`);

  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error("\n❌ Fatal Error:");
  console.error(error);
  process.exit(1);
});