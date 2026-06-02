import hre from "hardhat";

/**
 * Script para debuggear meta-transactions fallidas
 * Analiza el receipt y intenta extraer información del revert
 */

async function main() {
  const txHash = "0xef95eb5905f0be1e34419c9280eec5c105452995d6823b812563e90da6d544a1";
  
  console.log("🔍 Debugging failed meta-transaction");
  console.log("═══════════════════════════════════════\n");
  console.log("Transaction hash:", txHash);
  console.log("");

  try {
    // Obtener el receipt
    const receipt = await hre.ethers.provider.getTransactionReceipt(txHash);
    
    if (!receipt) {
      console.log("❌ Transaction not found");
      return;
    }

    console.log("📋 Transaction Receipt:");
    console.log("  - Status:", receipt.status === 0 ? "❌ FAILED" : "✅ SUCCESS");
    console.log("  - Block:", receipt.blockNumber);
    console.log("  - Gas Used:", receipt.gasUsed.toString());
    console.log("  - From:", receipt.from);
    console.log("  - To:", receipt.to);
    console.log("  - Logs:", receipt.logs.length);
    console.log("");

    // Obtener la transaction original
    const tx = await hre.ethers.provider.getTransaction(txHash);
    
    if (tx) {
      console.log("📤 Transaction Data:");
      console.log("  - Data length:", tx.data.length, "characters");
      console.log("  - Value:", hre.ethers.formatEther(tx.value || 0n), "ETH");
      console.log("  - Gas Limit:", tx.gasLimit?.toString());
      console.log("");

      // Intentar hacer un call estático para obtener el error
      console.log("🔬 Attempting to reproduce error with static call...\n");
      
      try {
        await hre.ethers.provider.call({
          from: tx.from,
          to: tx.to,
          data: tx.data,
          gasLimit: tx.gasLimit,
          value: tx.value,
        }, receipt.blockNumber - 1); // Call en el bloque anterior
        
        console.log("⚠️  Static call succeeded (unexpected)");
      } catch (error) {
        console.log("❌ Static call failed with:");
        
        if (error.data) {
          console.log("  - Error data:", error.data);
          
          // Intentar decodificar el error
          try {
            const errorInterface = new hre.ethers.Interface([
              "error Error(string)",
              "error Panic(uint256)"
            ]);
            
            const decoded = errorInterface.parseError(error.data);
            if (decoded) {
              console.log("  - Decoded error:", decoded.name);
              console.log("  - Args:", decoded.args);
            }
          } catch {
            console.log("  - Could not decode error data");
          }
        }
        
        if (error.reason) {
          console.log("  - Reason:", error.reason);
        }
        
        if (error.message) {
          console.log("  - Message:", error.message);
        }
      }
    }

    // Analizar logs (si hay)
    if (receipt.logs.length > 0) {
      console.log("\n📝 Transaction Logs:");
      receipt.logs.forEach((log, i) => {
        console.log(`\n  Log ${i}:`);
        console.log("    - Address:", log.address);
        console.log("    - Topics:", log.topics);
        console.log("    - Data:", log.data);
      });
    }

    // Información del Hub
    const hubAddress = "0x1B5c82C4093D2422699255f59f3B8A33c4a37773";
    console.log("\n🏢 Hub Contract Analysis:");
    console.log("  - Hub Address:", hubAddress);
    
    // Verificar si el hub tiene código
    const code = await hre.ethers.provider.getCode(hubAddress);
    console.log("  - Has code:", code !== "0x" ? "✅ Yes" : "❌ No");
    console.log("  - Code length:", code.length - 2, "hex chars");

  } catch (error) {
    console.error("\n❌ Error during debugging:");
    console.error(error);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });