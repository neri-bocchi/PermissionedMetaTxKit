import hre from "hardhat";

// Dirección a consultar
const ADDRESS = "0xa539d44d998782833a0ec0c788c5d42d5aa2c6f8";

async function getPendingTransactions() {
  console.log(`\nObteniendo transacciones pendientes para: ${ADDRESS}\n`);

  try {
    const provider = hre.ethers.provider;
    
    // Obtener el contenido del mempool pendiente
    const pendingBlock = await provider.send("eth_getBlockByNumber", [
      "pending",
      true
    ]);

    if (!pendingBlock || !pendingBlock.transactions) {
      console.log("No se pudo obtener el bloque pendiente o está vacío");
      return [];
    }

    console.log(`Total de transacciones en mempool: ${pendingBlock.transactions.length}`);

    // Filtrar transacciones relacionadas con la dirección
    const relevantTxs = pendingBlock.transactions.filter(tx => {
      const from = tx.from?.toLowerCase();
      const to = tx.to?.toLowerCase();
      const targetAddress = ADDRESS.toLowerCase();
      
      return from === targetAddress || to === targetAddress;
    });

    console.log(`\nTransacciones pendientes encontradas: ${relevantTxs.length}\n`);

    // Mostrar detalles de cada transacción
    relevantTxs.forEach((tx, index) => {
      console.log(`--- Transacción #${index + 1} ---`);
      console.log(`Hash: ${tx.hash}`);
      console.log(`From: ${tx.from}`);
      console.log(`To: ${tx.to || 'Contract Creation'}`);
      console.log(`Value: ${hre.ethers.formatEther(tx.value)} ETH`);
      console.log(`Gas Price: ${hre.ethers.formatUnits(tx.gasPrice || 0, 'gwei')} Gwei`);
      console.log(`Gas Limit: ${tx.gas}`);
      console.log(`Nonce: ${tx.nonce}`);
      console.log(`Data: ${tx.input.substring(0, 66)}${tx.input.length > 66 ? '...' : ''}`);
      console.log('');
    });

    return relevantTxs;

  } catch (error) {
    console.error("Error al obtener transacciones pendientes:", error.message);
    
    // Método alternativo usando txpool
    console.log("\nIntentando método alternativo con txpool...");
    return await getPendingFromTxPool();
  }
}

async function getPendingFromTxPool() {
  try {
    const provider = hre.ethers.provider;
    
    // Obtener el txpool content
    const txpool = await provider.send("txpool_content", []);
    
    const pendingTxs = [];
    const targetAddress = ADDRESS.toLowerCase();

    // Revisar transacciones pendientes
    if (txpool.pending) {
      for (const [address, txs] of Object.entries(txpool.pending)) {
        if (address.toLowerCase() === targetAddress) {
          for (const [nonce, tx] of Object.entries(txs)) {
            pendingTxs.push(tx);
            console.log(`Found pending tx from ${address} with nonce ${nonce}`);
          }
        }
        
        // También revisar si la dirección es el destino
        for (const [nonce, tx] of Object.entries(txs)) {
          if (tx.to?.toLowerCase() === targetAddress) {
            pendingTxs.push(tx);
            console.log(`Found pending tx to ${targetAddress} with nonce ${nonce}`);
          }
        }
      }
    }

    console.log(`\nTransacciones pendientes encontradas: ${pendingTxs.length}`);
    return pendingTxs;

  } catch (error) {
    console.error("Error con txpool_content:", error.message);
    console.log("\nNota: Es posible que el nodo no soporte txpool_content o no haya transacciones pendientes.");
    return [];
  }
}

// Función para monitorear continuamente
async function monitorPendingTransactions(intervalSeconds = 10) {
  console.log(`Monitoreando transacciones pendientes cada ${intervalSeconds} segundos...`);
  console.log('Presiona Ctrl+C para detener\n');

  while (true) {
    await getPendingTransactions();
    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
  }
}

// Ejecutar
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--monitor')) {
    const interval = parseInt(args[args.indexOf('--monitor') + 1]) || 10;
    await monitorPendingTransactions(interval);
  } else {
    await getPendingTransactions();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
