import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Servir archivos estáticos

// Configuration con validación
const CONFIG = {
    RPC_URL: process.env.RPC_URL || 'https://rpc-amoy.polygon.technology/',
    RELAYER_PK: process.env.RELAYER_PK,
    HUB_ADDRESS: process.env.HUB_ADDRESS || '0x8a65c1dA1cc41604DeBf001D6B944dAa8e2c4EF1',
    STORAGE_ADDRESS: process.env.STORAGE_ADDRESS || '0x98F6431E1CcdEc19087e3cE497275B2296fE46E7',
    CHAIN_ID: 80002,
    MAX_GAS_PRICE: ethers.parseUnits('100', 'gwei'), // Límite de gas price
    GAS_BUFFER: 1.3 // 30% buffer para gas
};

// Validar configuración crítica
if (!CONFIG.RELAYER_PK) {
    console.error('❌ ERROR: RELAYER_PK no está configurada en .env');
    process.exit(1);
}

// Hub ABI
const HUB_ABI = [
  "function execute((address,address,uint256,uint32,uint256,uint256,bytes32,address),bytes,bytes) payable",
  "function isNonceUsed(address,uint32,uint256) view returns (bool)",
  "function isCallerAllowed(address) view returns (bool)"
];

// Initialize provider and wallet
const provider = new ethers.JsonRpcProvider(CONFIG.RPC_URL);
const relayerWallet = new ethers.Wallet(CONFIG.RELAYER_PK, provider);
const hubContract = new ethers.Contract(CONFIG.HUB_ADDRESS, HUB_ABI, relayerWallet);

console.log('🚀 Relayer iniciado');
console.log('📍 Dirección:', relayerWallet.address);
console.log('🌐 Red:', CONFIG.CHAIN_ID);

// Rate limiting simple (en producción usar redis)
const requestCounts = new Map();
const RATE_LIMIT = 10; // requests por minuto
const RATE_WINDOW = 60000; // 1 minuto

function checkRateLimit(address) {
    const now = Date.now();
    const userRequests = requestCounts.get(address) || [];
    
    // Limpiar requests antiguos
    const recentRequests = userRequests.filter(time => now - time < RATE_WINDOW);
    
    if (recentRequests.length >= RATE_LIMIT) {
        return false;
    }
    
    recentRequests.push(now);
    requestCounts.set(address, recentRequests);
    return true;
}

// Health check
app.get('/health', async (req, res) => {
    try {
        const balance = await provider.getBalance(relayerWallet.address);
        const isAllowed = await hubContract.isCallerAllowed(relayerWallet.address);
        const network = await provider.getNetwork();
        
        res.json({
            status: 'ok',
            relayer: relayerWallet.address,
            balance: ethers.formatEther(balance),
            isAuthorized: isAllowed,
            chainId: Number(network.chainId),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

// Relay endpoint mejorado
app.post('/relay', async (req, res) => {
    try {
        const { forward, callData, signature } = req.body;

        // 1. Validación básica
        if (!forward || !callData || !signature) {
            return res.status(400).json({
                error: 'Faltan parámetros requeridos',
                required: ['forward', 'callData', 'signature']
            });
        }

        // 2. Rate limiting
        if (!checkRateLimit(forward.from)) {
            return res.status(429).json({
                error: 'Demasiadas solicitudes. Intenta de nuevo en un minuto.'
            });
        }

        console.log('\n📨 Nueva solicitud de relay');
        console.log('👤 De:', forward.from);
        console.log('📍 Para:', forward.to);
        console.log('🔢 Nonce:', forward.nonce);

        // 3. Actualizar caller al relayer
        const forwardWithCaller = {
            ...forward,
            caller: relayerWallet.address
        };

        // 4. Verificar autorización del relayer
        const isAuthorized = await hubContract.isCallerAllowed(relayerWallet.address);
        if (!isAuthorized) {
            console.log('❌ Relayer no autorizado');
            return res.status(403).json({
                error: 'Relayer no autorizado en el hub',
                relayer: relayerWallet.address
            });
        }

        // 5. Verificar nonce
        const nonceUsed = await hubContract.isNonceUsed(
            forward.from,
            forward.space,
            forward.nonce
        );

        if (nonceUsed) {
            console.log('❌ Nonce ya usado');
            return res.status(400).json({
                error: 'Nonce ya fue usado',
                nonce: forward.nonce,
                space: forward.space,
                from: forward.from
            });
        }

        console.log(`✅ Nonce ${forward.nonce} en space ${forward.space} disponible`);

        // 6. Verificar deadline
        const now = Math.floor(Date.now() / 1000);
        if (now > forward.deadline) {
            console.log('❌ Deadline expirado');
            return res.status(400).json({
                error: 'La transacción ha expirado',
                deadline: forward.deadline,
                now
            });
        }

        // 7. Verificar data hash
        const computedDataHash = ethers.keccak256(callData);
        if (computedDataHash !== forward.dataHash) {
            console.log('❌ DataHash no coincide');
            return res.status(400).json({
                error: 'Los datos no coinciden con el hash',
                expected: forward.dataHash,
                computed: computedDataHash
            });
        }

        // 8. Verificar firma (IMPORTANTE: usar forward CON caller actualizado)
        const domain = {
            name: 'PermissionedMetaTxHub',
            version: '1',
            chainId: CONFIG.CHAIN_ID,
            verifyingContract: CONFIG.HUB_ADDRESS
        };

        const types = {
            Forward: [
                { name: 'from', type: 'address' },
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'space', type: 'uint32' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
                { name: 'dataHash', type: 'bytes32' },
                { name: 'caller', type: 'address' },
           //     { name: 'salt', type: 'bytes32' }
            ]
        };

        const recoveredAddress = ethers.verifyTypedData(
            domain,
            types,
            forwardWithCaller,
            signature
        );

        if (recoveredAddress.toLowerCase() !== forward.from.toLowerCase()) {
            console.log('❌ Firma inválida');
            console.log('Esperado:', forward.from);
            console.log('Recuperado:', recoveredAddress);
            return res.status(400).json({
                error: 'Firma inválida',
                expected: forward.from,
                recovered: recoveredAddress
            });
        }

        console.log('✅ Firma válida');

        // 9. Verificar balance del relayer
        const relayerBalance = await provider.getBalance(relayerWallet.address);
        const minBalance = ethers.parseEther('0.01'); // Mínimo 0.01 POL

        if (relayerBalance < minBalance) {
            console.log('⚠️ Balance bajo del relayer');
            return res.status(503).json({
                error: 'Relayer con balance insuficiente',
                balance: ethers.formatEther(relayerBalance)
            });
        }

        // 10. Estimar gas
        console.log('📊 Estimando gas...');
        
        // Convertir forward object a array en el orden correcto para ethers v6
        const forwardArray = [
            forwardWithCaller.from,
            forwardWithCaller.to,
            forwardWithCaller.value,
            forwardWithCaller.space,
            forwardWithCaller.nonce,
            forwardWithCaller.deadline,
            forwardWithCaller.dataHash,
            forwardWithCaller.caller,
//            forwardWithCaller.salt
        ];
        
        console.log('🔧 Forward array:', forwardArray);
        
        //let gasEstimate;
        try {
        //    gasEstimate = await hubContract.execute.estimateGas(
        //        forwardArray,
        //        callData,
        //        signature,
        //        { value: forward.value }
        //    );
        //    console.log('⛽ Gas estimado:', gasEstimate.toString());
        } catch (error) {
            console.log('❌ Error en estimación de gas:', error);
            console.log('Error code:', error.code);
            console.log('Error reason:', error.reason);
            console.log('Error data:', error.data);
            
            // Intentar obtener más detalles del error
            let errorReason = error.reason || 'Transacción podría fallar';
            let errorDetails = error.message;
            
            if (error.data) {
                console.log('Error data hex:', error.data);
                // Intentar decodificar el revert reason
                try {
                    const revertReason = ethers.toUtf8String('0x' + error.data.slice(138));
                    errorReason = revertReason;
                    console.log('Revert reason decodificado:', revertReason);
                } catch (e) {
                    console.log('No se pudo decodificar revert reason');
                }
            }
            
            // Posibles causas del error
            const possibleCauses = [];
            if (errorDetails.includes('caller')) possibleCauses.push('Caller no autorizado en el Hub');
            if (errorDetails.includes('nonce')) possibleCauses.push('Nonce ya usado o inválido');
            if (errorDetails.includes('deadline')) possibleCauses.push('Deadline expirado');
            if (errorDetails.includes('signature')) possibleCauses.push('Firma inválida');
            if (errorDetails.includes('hash')) possibleCauses.push('DataHash no coincide');
            
            return res.status(400).json({
                error: 'Error al estimar gas',
                details: errorDetails,
                reason: errorReason,
                possibleCauses: possibleCauses.length > 0 ? possibleCauses : ['Verifica que el contrato Storage acepte la llamada'],
                forward: forwardWithCaller,
                callData
            });
        }

        // 11. Verificar gas price actual
        const feeData = await provider.getFeeData();
        if (feeData.gasPrice > CONFIG.MAX_GAS_PRICE) {
            console.log('⚠️ Gas price muy alto');
            return res.status(503).json({
                error: 'Gas price demasiado alto en este momento',
                currentGasPrice: ethers.formatUnits(feeData.gasPrice, 'gwei') + ' gwei',
                maxGasPrice: ethers.formatUnits(CONFIG.MAX_GAS_PRICE, 'gwei') + ' gwei'
            });
        }

        // 12. Enviar transacción
        console.log('🚀 Enviando transacción...');
        
        // Codificar la llamada manualmente
        const iface = new ethers.Interface(HUB_ABI);
        const encodedData = iface.encodeFunctionData('execute', [
            forwardArray,
            callData,
            signature
        ]);
        
        console.log('📦 Data codificada (primeros 200 chars):', encodedData.substring(0, 200));
        
        // Enviar transacción con data codificada
        const tx = await relayerWallet.sendTransaction({
            to: CONFIG.HUB_ADDRESS,
            data: encodedData,
            value: forward.value,
            gasLimit: 1_000_000,
        });

        console.log('📋 TX Hash:', tx.hash);
        console.log('⏳ Esperando confirmación...');

        // 13. Esperar confirmación
        const receipt = await tx.wait();

        console.log('✅ Confirmado en bloque:', receipt.blockNumber);
        console.log('⛽ Gas usado:', receipt.gasUsed.toString());
        console.log('💰 Costo:', ethers.formatEther(receipt.gasUsed * receipt.gasPrice), 'POL');

        // Verificar si la transacción revirtió
        if (receipt.status === 0) {
            console.error('❌ Transacción REVERTIDA on-chain');
            console.error('TX Hash:', tx.hash);
            console.error('Block:', receipt.blockNumber);
            console.error('Gas usado:', receipt.gasUsed.toString());
            
            // Intentar obtener el revert reason
            let revertReason = 'Transacción revertida sin mensaje específico';
            
            try {
                // Llamar de nuevo para obtener el revert reason
                const code = await provider.call({
                    to: CONFIG.HUB_ADDRESS,
                    data: tx.data,
                    from: relayerWallet.address
                }, receipt.blockNumber);
                
                console.log('Call result:', code);
            } catch (callError) {
                if (callError.data) {
                    console.log('Call error data:', callError.data);
                    // Intentar decodificar
                    try {
                        // Revert reason está después de 0x08c379a0 (Error(string))
                        if (callError.data.startsWith('0x08c379a0')) {
                            const reason = ethers.AbiCoder.defaultAbiCoder().decode(
                                ['string'],
                                '0x' + callError.data.slice(10)
                            );
                            revertReason = reason[0];
                        } else {
                            revertReason = callError.reason || callError.message;
                        }
                    } catch (decodeError) {
                        console.log('No se pudo decodificar revert reason');
                    }
                }
                console.log('Revert reason detectado:', revertReason);
            }
            
            return res.status(400).json({
                success: false,
                error: 'Transacción revertida on-chain',
                revertReason,
                txHash: tx.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString(),
                explorer: `https://amoy.polygonscan.com/tx/${tx.hash}`,
                possibleCauses: [
                    'Caller no autorizado en el Hub',
                    'Nonce ya usado',
                    'Deadline expirado',
                    'Firma inválida (verificación on-chain)',
                    'DataHash no coincide con callData',
                    'El contrato Storage rechazó la llamada'
                ]
            });
        }

        // 14. Respuesta exitosa
        res.json({
            success: true,
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice: receipt.gasPrice.toString(),
            cost: ethers.formatEther(receipt.gasUsed * receipt.gasPrice),
            from: forward.from,
            to: forward.to,
            explorer: `https://amoy.polygonscan.com/tx/${tx.hash}`
        });

    } catch (error) {
        console.error('❌ Error:', error);
        
        // Mejor manejo de errores
        let errorMessage = error.message;
        let errorCode = 'UNKNOWN_ERROR';
        
        if (error.code === 'INSUFFICIENT_FUNDS') {
            errorMessage = 'Fondos insuficientes en el relayer';
            errorCode = 'INSUFFICIENT_FUNDS';
        } else if (error.code === 'NONCE_EXPIRED') {
            errorMessage = 'Nonce expirado';
            errorCode = 'NONCE_EXPIRED';
        } else if (error.reason) {
            errorMessage = error.reason;
            errorCode = 'CONTRACT_ERROR';
        }
        
        res.status(500).json({
            error: errorMessage,
            code: errorCode,
            details: error.message
        });
    }
});

// Get relayer stats
app.get('/stats', async (req, res) => {
    try {
        const balance = await provider.getBalance(relayerWallet.address);
        const isAllowed = await hubContract.isCallerAllowed(relayerWallet.address);
        const blockNumber = await provider.getBlockNumber();
        const network = await provider.getNetwork();

        res.json({
            relayer: relayerWallet.address,
            balance: ethers.formatEther(balance),
            balanceWei: balance.toString(),
            isAuthorized: isAllowed,
            chainId: Number(network.chainId),
            blockNumber,
            hubAddress: CONFIG.HUB_ADDRESS,
            storageAddress: CONFIG.STORAGE_ADDRESS,
            maxGasPrice: ethers.formatUnits(CONFIG.MAX_GAS_PRICE, 'gwei') + ' gwei'
        });
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

// Verify signature endpoint (debugging)
app.post('/verify', async (req, res) => {
    try {
        const { forward, signature } = req.body;

        const domain = {
            name: 'PermissionedMetaTxHub',
            version: '1',
            chainId: CONFIG.CHAIN_ID,
            verifyingContract: CONFIG.HUB_ADDRESS
        };

        const types = {
            Forward: [
                { name: 'from', type: 'address' },
                { name: 'to', type: 'address' },
                { name: 'value', type: 'uint256' },
                { name: 'space', type: 'uint32' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
                { name: 'dataHash', type: 'bytes32' },
                { name: 'caller', type: 'address' },
            //    { name: 'salt', type: 'bytes32' }
            ]
        };

        const recoveredAddress = ethers.verifyTypedData(
            domain,
            types,
            forward,
            signature
        );

        res.json({
            recoveredAddress,
            expectedAddress: forward.from,
            isValid: recoveredAddress.toLowerCase() === forward.from.toLowerCase(),
            domain,
            forward
        });
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

// Get nonce status
app.get('/nonce/:address/:space/:nonce', async (req, res) => {
    try {
        const { address, space, nonce } = req.params;
        
        const isUsed = await hubContract.isNonceUsed(
            address,
            parseInt(space),
            parseInt(nonce)
        );
        
        res.json({
            address,
            space: parseInt(space),
            nonce: parseInt(nonce),
            isUsed
        });
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

// Error handler
app.use((error, req, res, next) => {
    console.error('Error no capturado:', error);
    res.status(500).json({
        error: 'Error interno del servidor',
        message: error.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint no encontrado',
        path: req.path
    });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`\n🎉 Servidor escuchando en puerto ${PORT}`);
    console.log(`📡 Health check: http://localhost:${PORT}/health`);
    console.log(`📊 Stats: http://localhost:${PORT}/stats`);
    console.log(`📤 Relay endpoint: http://localhost:${PORT}/relay`);
    console.log(`🔍 Verify endpoint: http://localhost:${PORT}/verify`);
});

// Graceful shutdown
const shutdown = async () => {
    console.log('\n👋 Cerrando servidor...');
    server.close(() => {
        console.log('✅ Servidor cerrado');
        process.exit(0);
    });
    
    // Forzar cierre después de 10 segundos
    setTimeout(() => {
        console.error('⚠️ Forzando cierre...');
        process.exit(1);
    }, 10000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default app;