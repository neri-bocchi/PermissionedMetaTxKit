import hre from "hardhat";

async function main() {
  const txHash = "0x9453ff47c8de017a535abd8482ef85e0852a50d9ece496bc10abc8b5e0d435c4";
  
  console.log("🔍 Debugging failed meta-transaction");
  console.log("═══════════════════════════════════════\n");
  console.log("Transaction hash:", txHash);
  console.log("");

  const receipt = await hre.ethers.provider.getTransactionReceipt(txHash);
  
  if (!receipt) {
    console.log("❌ Transaction not found");
    return;
  }

  console.log("📋 Transaction Receipt:");
  console.log("  - Status:", receipt.status === 0 ? "❌ FAILED" : "✅ SUCCESS");
  console.log("  - Block:", receipt.blockNumber);
  console.log("  - Gas Used:", receipt.gasUsed.toString(), "(increased from 60394)");
  console.log("  - From:", receipt.from);
  console.log("  - To:", receipt.to);
  console.log("");

  const tx = await hre.ethers.provider.getTransaction(txHash);
  
  if (tx) {
    console.log("🔬 Attempting to reproduce error with static call...\n");
    
    try {
      await hre.ethers.provider.call({
        from: tx.from,
        to: tx.to,
        data: tx.data,
        gasLimit: tx.gasLimit,
        value: tx.value,
      }, receipt.blockNumber - 1);
      
      console.log("⚠️  Static call succeeded (unexpected)");
    } catch (error) {
      console.log("❌ Static call failed:");
      
      if (error.data) {
        console.log("  Error data:", error.data);
        
        // Identificar el error
        const hubErrors = [
          "error CallerNotAllowed()",
          "error UnexpectedCaller()",
          "error DeadlineExpired()",
          "error DataMismatch()",
          "error DigestUsed()",
          "error NonceUsed()",
          "error BadMsgValue()",
          "error CreateFailed()",
          "error BlockGasQuotaExceeded()",
          "error ZeroAddress()",
          "error InvalidSignature()",
          "error DeployGasExceeded()",
          "error DeployPerBlockExceeded()",
          "error DeployTimeWindowGasExceeded()",
          "error DeployerNotAllowed()",
        ];

        console.log("\n🔎 Matching error...\n");

        for (const errorSig of hubErrors) {
          try {
            const iface = new hre.ethers.Interface([errorSig]);
            const errorName = errorSig.match(/error (\w+)/)?.[1];
            if (!errorName) continue;
            
            const fragment = iface.getError(errorName);
            const selector = fragment?.selector;
            
            if (selector === error.data) {
              console.log("✅ MATCH FOUND!");
              console.log("═══════════════════════════════════════");
              console.log("Error:", errorSig);
              console.log("Selector:", selector);
              console.log("═══════════════════════════════════════\n");
              
              // Dar solución específica
              switch (errorName) {
                case "DeployerNotAllowed":
                  console.log("💡 Solution:");
                  console.log("   The Hub owner must run:");
                  console.log('   await hub.setAllowedDeployer("0x5fB09D06843f407982adCBe99453792769b6dD38", true)');
                  break;
                case "NonceUsed":
                  console.log("💡 Solution:");
                  console.log("   This nonce (462316) has already been used.");
                  console.log("   Fetch a fresh nonce from the Hub using the bitmap.");
                  break;
                case "InvalidSignature":
                  console.log("💡 Solution:");
                  console.log("   The signature doesn't match. Check:");
                  console.log("   - EIP-712 domain (name, version, chainId, verifyingContract)");
                  console.log("   - Types structure (uint32 for space, not uint256)");
                  console.log("   - Message values");
                  break;
                case "DigestUsed":
                  console.log("💡 Solution:");
                  console.log("   This exact request has already been executed.");
                  console.log("   Change the nonce or any other parameter.");
                  break;
                default:
                  console.log("💡 Error identified. Check Hub contract logic.");
              }
              
              return;
            }
          } catch (e) {
            // Skip
          }
        }
        
        console.log("❌ Could not identify error:", error.data);
      }
      
      if (error.message) {
        console.log("  Message:", error.message);
      }
    }
  }

  // Análisis del Hub
  const hubAddress = "0x1B5c82C4093D2422699255f59f3B8A33c4a37773";
  const signerAddress = "0x5fB09D06843f407982adCBe99453792769b6dD38";
  const relayerAddress = "0x248906Bf539e8f16FbD14c001f7Bd3D712f95D3E";

  console.log("\n🏢 Hub State Analysis:");
  
  const hub = await hre.ethers.getContractAt(
    [
      "function isCallerAllowed(address) view returns (bool)",
      "function allowedDeployers(address) view returns (bool)",
      "function getDeployerInfo(address) view returns (tuple(address,bool,uint256,uint64,uint256,uint256,uint64,bool))",
    ],
    hubAddress
  );

  try {
    const isRelayerAllowed = await hub.isCallerAllowed(relayerAddress);
    console.log("  - Relayer allowed:", isRelayerAllowed ? "✅ YES" : "❌ NO");
  } catch (e) {
    console.log("  - Could not check relayer");
  }

  try {
    const isDeployerAllowed = await hub.allowedDeployers(signerAddress);
    console.log("  - Deployer allowed:", isDeployerAllowed ? "✅ YES" : "❌ NO");
    
    if (!isDeployerAllowed) {
      console.log("\n❌ PROBLEM FOUND: Deployer is not allowed!");
      console.log("   This is likely causing error 0x8baa579f (DeployerNotAllowed)");
      console.log("\n   Hub owner must run:");
      console.log(`   await hub.setAllowedDeployer("${signerAddress}", true)`);
    }
  } catch (e) {
    console.log("  - Could not check deployer allowlist");
  }

  try {
    const deployerInfo = await hub.getDeployerInfo(signerAddress);
    console.log("\n  Deployer Info:");
    console.log("    - Allowed:", deployerInfo[1]);
    console.log("    - Gas used in window:", deployerInfo[2].toString());
    console.log("    - Last deploy block:", deployerInfo[4].toString());
    console.log("    - Current block:", receipt.blockNumber);
  } catch (e) {
    console.log("  - Could not get deployer info");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });