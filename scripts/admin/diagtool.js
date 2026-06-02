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
 * Script para obtener callers y deployers permitidos
 */

function log(message) {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

async function main() {
  const result = {
    timestamp: new Date().toISOString(),
    contract: {},
    network: {},
    callers: {
      allowed: [],
      count: 0,
      gasLimits: {}
    },
    deployers: {
      allowed: [],
      count: 0,
      detailed: []
    },
    config: {},
    error: null
  };

  try {
    const rpc = process.env.RPC_URL;
    const hubAddress = process.env.HUB_ADDRESS;

    if (!rpc || !hubAddress) {
      result.error = "Missing RPC_URL or HUB_ADDRESS in .env";
      console.log(JSON.stringify(result, null, 2));
      process.exit(1);
    }

    log("Connecting to network...");
    const provider = new ethers.JsonRpcProvider(rpc);
    const metaAddr = ethers.getAddress(hubAddress);
    
    log(`Contract: ${metaAddr}`);
    result.contract.address = metaAddr;

    // Get network info
    log("Getting network info...");
    const network = await provider.getNetwork();
    const blockNumber = await provider.getBlockNumber();
    
    result.network = {
      name: network.name,
      chainId: network.chainId.toString(),
      currentBlock: blockNumber
    };
    
    log(`Network: ${network.name} (${network.chainId})`);
    log(`Block: ${blockNumber}`);

    // Contract ABI
    const abi = [
      // Callers
      "function getAllowedCallers() view returns (address[])",
      "function getAllowedCallersCount() view returns (uint256)",
      "function isCallerAllowed(address) view returns (bool)",
      "function gasLimitPerBlock(address) view returns (uint256)",
      "function gasUsedThisBlock(address) view returns (uint256 used, uint256 limit, uint256 blockNo)",
      
      // Deployers
      "function getAllowedDeployers() view returns (address[])",
      "function getAllowedDeployersCount() view returns (uint256)",
      "function allowedDeployers(address) view returns (bool)",
      "function getDeployerInfo(address) view returns (tuple(address deployer, bool allowed, uint256 gasUsedInWindow, uint64 windowStartedAt, uint256 lastDeployBlock))",
      "function getDeployersInfo(address[]) view returns (tuple(address deployer, bool allowed, uint256 gasUsedInWindow, uint64 windowStartedAt, uint256 lastDeployBlock)[])",
      
      // Config
      "function deployGasBucketLimit() view returns (uint256)",
      "function deployGasBucketDuration() view returns (uint64)",
      "function gasAccountingOverhead() view returns (uint256)",
      "function erc2771AppendSender() view returns (bool)"
    ];
    
    const contract = new ethers.Contract(metaAddr, abi, provider);

    // ========= CALLERS =========
    log("\n=== FETCHING CALLERS ===");
    
    try {
      log("Getting allowed callers...");
      const callers = await contract.getAllowedCallers();
      log(`Found ${callers.length} allowed callers`);
      
      result.callers.allowed = callers;
      result.callers.count = callers.length;

      // Get gas limits for each caller
      log("Getting gas limits for callers...");
      for (const caller of callers) {
        try {
          const gasLimit = await contract.gasLimitPerBlock(caller);
          result.callers.gasLimits[caller] = gasLimit.toString();
          log(`  ${caller}: ${gasLimit.toString()} gas/block`);
        } catch (e) {
          log(`  ${caller}: Error getting gas limit - ${e.message}`);
          result.callers.gasLimits[caller] = "ERROR";
        }
      }
    } catch (e) {
      log(`Error getting callers: ${e.message}`);
      log("Trying fallback method (checking individual addresses)...");
      
      // Fallback: si getAllowedCallers no existe, intentar con addresses conocidas
      const knownCallers = process.argv.slice(2).filter(addr => {
        try {
          ethers.getAddress(addr);
          return true;
        } catch {
          return false;
        }
      });
      
      if (knownCallers.length > 0) {
        log(`Checking ${knownCallers.length} known addresses...`);
        for (const addr of knownCallers) {
          try {
            const normalized = ethers.getAddress(addr);
            const isAllowed = await contract.isCallerAllowed(normalized);
            
            if (isAllowed) {
              result.callers.allowed.push(normalized);
              const gasLimit = await contract.gasLimitPerBlock(normalized);
              result.callers.gasLimits[normalized] = gasLimit.toString();
              log(`  ${normalized}: ALLOWED (${gasLimit.toString()} gas/block)`);
            }
          } catch (e) {
            log(`  ${addr}: Error - ${e.message}`);
          }
        }
        result.callers.count = result.callers.allowed.length;
      } else {
        result.error = "getAllowedCallers() not available and no addresses provided";
      }
    }

    // ========= DEPLOYERS =========
    log("\n=== FETCHING DEPLOYERS ===");
    
    try {
      log("Getting allowed deployers...");
      const deployers = await contract.getAllowedDeployers();
      log(`Found ${deployers.length} allowed deployers`);
      
      result.deployers.allowed = deployers;
      result.deployers.count = deployers.length;

      // Get detailed info for all deployers in batch
      if (deployers.length > 0) {
        log("Getting detailed info for all deployers...");
        try {
          const deployersInfo = await contract.getDeployersInfo(deployers);
          
          for (let i = 0; i < deployersInfo.length; i++) {
            const info = deployersInfo[i];
            const detailedInfo = {
              address: info.deployer,
              allowed: info.allowed,
              gasUsedInWindow: info.gasUsedInWindow.toString(),
              windowStartedAt: info.windowStartedAt.toString(),
              windowStartedAtDate: info.windowStartedAt > 0 
                ? new Date(Number(info.windowStartedAt) * 1000).toISOString() 
                : null,
              lastDeployBlock: info.lastDeployBlock.toString()
            };
            
            result.deployers.detailed.push(detailedInfo);
            
            log(`  ${info.deployer}:`);
            log(`    Allowed: ${info.allowed}`);
            log(`    Gas used in window: ${info.gasUsedInWindow.toString()}`);
            log(`    Window started: ${detailedInfo.windowStartedAtDate || 'Never'}`);
            log(`    Last deploy block: ${info.lastDeployBlock.toString()}`);
          }
        } catch (e) {
          log(`Error getting batch deployer info: ${e.message}`);
          log("Falling back to individual queries...");
          
          // Fallback: consultar uno por uno
          for (const deployer of deployers) {
            try {
              const info = await contract.getDeployerInfo(deployer);
              const detailedInfo = {
                address: info.deployer,
                allowed: info.allowed,
                gasUsedInWindow: info.gasUsedInWindow.toString(),
                windowStartedAt: info.windowStartedAt.toString(),
                windowStartedAtDate: info.windowStartedAt > 0 
                  ? new Date(Number(info.windowStartedAt) * 1000).toISOString() 
                  : null,
                lastDeployBlock: info.lastDeployBlock.toString()
              };
              
              result.deployers.detailed.push(detailedInfo);
              log(`  ${deployer}: OK`);
            } catch (e) {
              log(`  ${deployer}: Error - ${e.message}`);
              result.deployers.detailed.push({
                address: deployer,
                allowed: true,
                error: e.message
              });
            }
          }
        }
      }
    } catch (e) {
      log(`Error getting deployers: ${e.message}`);
      log("Trying fallback method (checking individual addresses)...");
      
      // Fallback: si getAllowedDeployers no existe
      const knownDeployers = process.argv.slice(2).filter(addr => {
        try {
          ethers.getAddress(addr);
          return true;
        } catch {
          return false;
        }
      });
      
      if (knownDeployers.length > 0) {
        log(`Checking ${knownDeployers.length} known addresses...`);
        for (const addr of knownDeployers) {
          try {
            const normalized = ethers.getAddress(addr);
            const isAllowed = await contract.allowedDeployers(normalized);
            
            if (isAllowed) {
              result.deployers.allowed.push(normalized);
              
              try {
                const info = await contract.getDeployerInfo(normalized);
                result.deployers.detailed.push({
                  address: info.deployer,
                  allowed: info.allowed,
                  gasUsedInWindow: info.gasUsedInWindow.toString(),
                  windowStartedAt: info.windowStartedAt.toString(),
                  windowStartedAtDate: info.windowStartedAt > 0 
                    ? new Date(Number(info.windowStartedAt) * 1000).toISOString() 
                    : null,
                  lastDeployBlock: info.lastDeployBlock.toString()
                });
                log(`  ${normalized}: ALLOWED`);
              } catch (e) {
                result.deployers.detailed.push({
                  address: normalized,
                  allowed: true
                });
              }
            }
          } catch (e) {
            log(`  ${addr}: Error - ${e.message}`);
          }
        }
        result.deployers.count = result.deployers.allowed.length;
      } else {
        result.error = "getAllowedDeployers() not available and no addresses provided";
      }
    }

    // ========= CONFIG =========
    log("\n=== FETCHING CONFIG ===");
    
    try {
      log("Getting contract configuration...");
      
      const deployGasLimit = await contract.deployGasBucketLimit();
      const deployDuration = await contract.deployGasBucketDuration();
      const gasOverhead = await contract.gasAccountingOverhead();
      const erc2771 = await contract.erc2771AppendSender();
      
      result.config = {
        deployGasBucketLimit: deployGasLimit.toString(),
        deployGasBucketDuration: deployDuration.toString(),
        deployGasBucketDurationMinutes: (Number(deployDuration) / 60).toFixed(2),
        gasAccountingOverhead: gasOverhead.toString(),
        erc2771AppendSender: erc2771
      };
      
      log(`  Deploy gas bucket limit: ${deployGasLimit.toString()}`);
      log(`  Deploy bucket duration: ${deployDuration.toString()}s (${result.config.deployGasBucketDurationMinutes} min)`);
      log(`  Gas accounting overhead: ${gasOverhead.toString()}`);
      log(`  ERC-2771 append sender: ${erc2771}`);
    } catch (e) {
      log(`Error getting config: ${e.message}`);
      result.config.error = e.message;
    }

    log("\n=== COMPLETE ===");
    log(`Total callers: ${result.callers.count}`);
    log(`Total deployers: ${result.deployers.count}`);
    
    // Output final JSON
    console.log(JSON.stringify(result, null, 2));

  } catch (e) {
    result.error = e.message;
    log(`\nFatal error: ${e.message}`);
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

main().catch((e) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    contract: {},
    network: {},
    callers: { allowed: [], count: 0, gasLimits: {} },
    deployers: { allowed: [], count: 0, detailed: [] },
    config: {},
    error: e.message
  }, null, 2));
  process.exit(1);
});