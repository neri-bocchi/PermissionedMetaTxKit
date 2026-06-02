import hre from "hardhat";

async function main() {
  console.log("🔍 Identifying Hub Custom Error: 0x8baa579f\n");
  
  const errorData = "0x8baa579f";
  
  // Todos los custom errors del Hub
  const hubErrors = [
    "error CallerNotAllowed()",
    "error UnexpectedCaller()",
    "error DeadlineExpired()",
    "error DataMismatch()",
    "error DigestUsed()",
    "error NonceUsed()",
    "error BadMsgValue()",
    "error CreateFailed()",
    "error CallFailed(bytes returnData)",
    "error BlockGasQuotaExceeded()",
    "error ZeroAddress()",
    "error InvalidSignature()",
    "error DeployGasExceeded()",
    "error DeployPerBlockExceeded()",
    "error DeployTimeWindowGasExceeded()",
    "error DeployerNotAllowed()",
  ];

  console.log("Testing all Hub errors...\n");

  for (const errorSig of hubErrors) {
    try {
      const iface = new hre.ethers.Interface([errorSig]);
      const errorName = errorSig.match(/error (\w+)/)?.[1];
      if (!errorName) continue;
      
      const fragment = iface.getError(errorName);
      const selector = fragment?.selector;
      
      if (selector === errorData) {
        console.log("✅ MATCH FOUND!");
        console.log("═══════════════════════════════════════");
        console.log("Error:", errorSig);
        console.log("Selector:", selector);
        console.log("═══════════════════════════════════════\n");
        
        // Explicar el error
        switch (errorName) {
          case "DeployerNotAllowed":
            console.log("📋 Explanation:");
            console.log("   The signer (from) is not in the allowedDeployers list.");
            console.log("   Only addresses that have been explicitly allowed can deploy contracts.");
            console.log("");
            console.log("🔧 Solution:");
            console.log("   The Hub owner needs to run:");
            console.log("   hub.setAllowedDeployer(signerAddress, true)");
            break;
          case "NonceUsed":
            console.log("📋 Explanation:");
            console.log("   This nonce has already been used.");
            console.log("");
            console.log("🔧 Solution:");
            console.log("   Fetch a fresh nonce from the Hub before signing.");
            break;
          case "InvalidSignature":
            console.log("📋 Explanation:");
            console.log("   The signature doesn't match the expected signer.");
            console.log("");
            console.log("🔧 Solution:");
            console.log("   Verify the EIP-712 domain, types, and message are correct.");
            break;
          case "DeadlineExpired":
            console.log("📋 Explanation:");
            console.log("   The deadline timestamp has passed.");
            console.log("");
            console.log("🔧 Solution:");
            console.log("   Use a fresh deadline: Math.floor(Date.now()/1000) + 3600");
            break;
          case "CallerNotAllowed":
            console.log("📋 Explanation:");
            console.log("   The relayer (caller) is not in the isCallerAllowed list.");
            console.log("");
            console.log("🔧 Solution:");
            console.log("   The Hub owner needs to run:");
            console.log("   hub.setCallerAllowed(relayerAddress, true)");
            break;
          default:
            console.log("📋 This error needs to be fixed based on the contract logic.");
        }
        
        return;
      } else {
        console.log(`  ${errorSig.padEnd(50)} → ${selector}`);
      }
    } catch (e) {
      // Skip errors that can't be parsed
    }
  }
  
  console.log("\n❌ No exact match found!");
  console.log("   Error selector: 0x8baa579f");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });