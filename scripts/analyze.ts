import hre from "hardhat";

/**
 * Decodificar custom errors del Hub
 * Error data: 0x8baa579f
 */

async function main() {
  console.log("🔍 Decoding Hub Custom Error");
  console.log("═══════════════════════════════════════\n");
  
  const errorData = "0x8baa579f";
  console.log("Error data:", errorData);
  console.log("");

  // Custom errors comunes en contratos de meta-transactions
  const commonErrors = [
    "error InvalidSignature()",
    "error ExpiredDeadline()",
    "error InvalidNonce()",
    "error UnauthorizedCaller()",
    "error CallerNotAllowed()",
    "error ExecutionFailed()",
    "error InvalidForwardRequest()",
    "error NonceAlreadyUsed()",
  ];

  console.log("🔎 Trying to match with common errors...\n");

  for (const errorSig of commonErrors) {
    const iface = new hre.ethers.Interface([errorSig]);
    const selector = iface.getError(errorSig.match(/error (\w+)/)?.[1] || "")?.selector;
    
    if (selector === errorData) {
      console.log("✅ MATCH FOUND!");
      console.log("  Error:", errorSig);
      console.log("");
      return;
    } else {
      console.log(`  ${errorSig.padEnd(40)} → ${selector}`);
    }
  }

  console.log("\n❌ No match found in common errors");
  console.log("\n💡 This could be a custom error specific to the Hub contract.");
  console.log("   Check the Hub's source code or ABI for the exact error definition.");
  
  // Calcular el selector manualmente
  console.log("\n🧮 Error Selector Calculation:");
  console.log("  The selector 0x8baa579f represents the first 4 bytes of");
  console.log("  keccak256('ErrorName()') or keccak256('ErrorName(type)')");
  
  // Intentar algunos errores más específicos
  const specificErrors = [
    "error Unauthorized()",
    "error Forbidden()",
    "error NotAllowed()",
    "error InvalidCaller()",
    "error CallerMismatch()",
    "error SignatureVerificationFailed()",
    "error InvalidSpace()",
    "error InvalidValue()",
  ];

  console.log("\n🔎 Trying more specific errors...\n");

  for (const errorSig of specificErrors) {
    const iface = new hre.ethers.Interface([errorSig]);
    const selector = iface.getError(errorSig.match(/error (\w+)/)?.[1] || "")?.selector;
    
    if (selector === errorData) {
      console.log("✅ MATCH FOUND!");
      console.log("  Error:", errorSig);
      console.log("");
      return;
    } else {
      console.log(`  ${errorSig.padEnd(50)} → ${selector}`);
    }
  }

  console.log("\n📝 Recommendation:");
  console.log("  1. Check the Hub contract's source code or verified ABI");
  console.log("  2. Look for 'error' definitions in the contract");
  console.log("  3. The error selector is: 0x8baa579f");
  console.log("");
  console.log("  If the Hub is verified on the explorer, you can:");
  console.log("  - Visit: https://phoenix.lightlink.io/address/0x1B5c82C4093D2422699255f59f3B8A33c4a37773");
  console.log("  - Check the 'Read Contract' or 'Contract' tab");
  console.log("  - Look for error definitions in the source code");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });