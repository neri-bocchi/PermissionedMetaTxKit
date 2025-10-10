# 🚀 Meta-Transaction Hub DApp

A complete gasless transaction DApp using **PermissionedMetaTxHub** with EIP-712 signatures. Users can interact with smart contracts without paying gas fees - the relayer handles all transaction costs.

![Version](https://img.shields.io/badge/version-2.0.1-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Network](https://img.shields.io/badge/network-Polygon%20Amoy-purple)

## 🌟 Features

- ✅ **Gasless Transactions** - Users don't need POL tokens
- ✅ **EIP-712 Signatures** - Secure, human-readable signing
- ✅ **Automatic Relayer** - Backend pays gas for users
- ✅ **Full Validation** - Signature, nonce, and deadline checks
- ✅ **Rate Limiting** - Protection against abuse
- ✅ **Modern UI** - Clean, responsive interface
- ✅ **Error Handling** - Detailed error messages and debugging

## 📋 Prerequisites

- **Node.js** v14 or higher
- **MetaMask** browser extension
- **POL tokens** on Polygon Amoy (for relayer)
- **Deployed contracts:**
  - PermissionedMetaTxHub
  - SimpleStorage (or your target contract)

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
# Server Configuration
PORT=3000

# Blockchain Configuration
RPC_URL=https://rpc-amoy.polygon.technology/
CHAIN_ID=80002

# Relayer Configuration (KEEP PRIVATE!)
RELAYER_PK=your_private_key_here

# Contract Addresses
HUB_ADDRESS=0xF027499839d08bC7D987f8BCF5A975830073Efc1
STORAGE_ADDRESS=0x98F6431E1CcdEc19087e3cE497275B2296fE46E7
```

⚠️ **IMPORTANT:** The relayer wallet needs:
- POL tokens for gas (minimum 0.1 POL recommended)
- Authorization in the PermissionedMetaTxHub

### 3. Verify Configuration

```bash
npm run diagnose
```

This will check:
- ✅ Environment variables configured
- ✅ Network connection
- ✅ Relayer balance
- ✅ Contracts deployed
- ✅ Relayer authorized in Hub
- ✅ EIP-712 signature working

### 4. Authorize Relayer (if needed)

If the relayer is not authorized:

```bash
node authorize-relayer.js
```

Follow the on-screen instructions. You'll need the Hub owner's private key.

### 5. Start the Server

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

The server will start at `http://localhost:3000`

### 6. Use the DApp

1. Open `http://localhost:3000` in your browser
2. Click "Connect MetaMask"
3. Approve the connection
4. Enter a number and click "Store Value"
5. Sign the message in MetaMask (no gas cost!)
6. Wait for confirmation (~2-5 seconds)

## 📂 Project Structure

```
metatx-hub-dapp/
├── index.html              # Frontend (DApp UI)
├── server.js              # Backend (Relayer service)
├── diagnose.js            # Diagnostic script
├── authorize-relayer.js   # Authorization script
├── debug-tx.js            # Transaction debugger
├── package.json           # Dependencies
├── .env                   # Configuration (create from .env.example)
├── .env.example           # Configuration template
├── .gitignore            # Protect sensitive files
├── README.md             # This file
├── QUICKSTART.md         # Quick start guide
├── TROUBLESHOOTING.md    # Problem solving
├── CHANGELOG.md          # Version history
└── ISSUE_RESOLVED.md     # Space issue documentation
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `RPC_URL` | Blockchain RPC endpoint | `https://rpc-amoy.polygon.technology/` |
| `CHAIN_ID` | Network chain ID | `80002` (Polygon Amoy) |
| `RELAYER_PK` | Relayer private key | `0x...` |
| `HUB_ADDRESS` | PermissionedMetaTxHub address | `0x...` |
| `STORAGE_ADDRESS` | SimpleStorage address | `0x...` |

### Frontend Configuration

Edit `index.html` to update:

```javascript
const CONFIG = {
    STORAGE_ADDRESS: '0x...',  // Your Storage contract
    HUB_ADDRESS: '0x...',      // Your Hub contract
    BACKEND_URL: 'http://localhost:3000',
    CHAIN_ID: 80002,
    NETWORK_NAME: 'Polygon Amoy'
};
```

### Space Configuration

The DApp uses `space = 1500` by default. This is a namespace for organizing meta-transactions.

**Important:** Different spaces may have different permissions in the Hub. If you need to use a different space, update both frontend and tests to use the same value.

```javascript
// In index.html
const space = 1500;  // Must match your Hub configuration
```

## 🔍 API Endpoints

### Health Check
```bash
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "relayer": "0x...",
  "balance": "0.5",
  "isAuthorized": true,
  "chainId": 80002
}
```

### Relayer Stats
```bash
GET /stats
```

**Response:**
```json
{
  "relayer": "0x...",
  "balance": "0.5",
  "isAuthorized": true,
  "chainId": 80002,
  "blockNumber": 27531000,
  "hubAddress": "0x...",
  "storageAddress": "0x..."
}
```

### Relay Transaction
```bash
POST /relay
Content-Type: application/json

{
  "forward": {
    "from": "0x...",
    "to": "0x...",
    "value": 0,
    "space": 1500,
    "nonce": 1760120000,
    "deadline": 1760123600,
    "dataHash": "0x...",
    "caller": "0x...",
    "salt": "0x0000..."
  },
  "callData": "0x...",
  "signature": "0x..."
}
```

### Verify Signature
```bash
POST /verify
Content-Type: application/json

{
  "forward": {...},
  "signature": "0x..."
}
```

### Check Nonce Status
```bash
GET /nonce/:address/:space/:nonce
```

## 🛠️ Utility Scripts

### Diagnose Configuration
```bash
npm run diagnose
```
Verifies all configuration and detects problems automatically.

### Debug Transaction
```bash
npm run debug-tx
```
Analyzes a failed transaction to identify the root cause.

### Authorize Relayer
```bash
node authorize-relayer.js
```
Interactively authorizes the relayer in the Hub.

## 🐛 Troubleshooting

### Transaction Reverting

If transactions are reverting on-chain:

1. **Check relayer authorization:**
   ```bash
   npm run diagnose
   ```
   If not authorized, run `node authorize-relayer.js`

2. **Debug the transaction:**
   ```bash
   npm run debug-tx
   ```
   Enter the failed TX hash when prompted

3. **Verify space configuration:**
   - Frontend should use `space = 1500`
   - Check your Hub allows this space

4. **Check logs:**
   - Low gas usage (~32k) = early revert (validation failed)
   - Normal gas usage (~150k+) = successful execution

### Common Errors

#### "Relayer not authorized"
**Solution:** Run `node authorize-relayer.js` with the Hub owner's key.

#### "Insufficient funds"
**Solution:** Send POL to the relayer address (check with `npm run diagnose`).

#### "Nonce already used"
**Solution:** Wait a second and try again. The DApp uses timestamp as nonce.

#### "Wrong network"
**Solution:** Switch MetaMask to Polygon Amoy:
- Network Name: `Polygon Amoy`
- RPC URL: `https://rpc-amoy.polygon.technology/`
- Chain ID: `80002`
- Currency: `POL`
- Explorer: `https://amoy.polygonscan.com/`

For more detailed troubleshooting, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

## 🔒 Security

### Best Practices

1. **Never expose `RELAYER_PK`**
   - Use environment variables
   - Don't commit `.env` to git
   - Rotate keys regularly

2. **Monitor relayer balance**
   - Keep sufficient POL (>0.01)
   - Set up low balance alerts

3. **Rate limiting**
   - Default: 10 requests/minute per user
   - Adjust in server.js if needed

4. **Gas limits**
   - Max gas price: 100 gwei (configurable)
   - Gas buffer: 30% (configurable)

### Implemented Security Features

- ✅ **EIP-712 Signature Verification** - Prevents unauthorized transactions
- ✅ **Nonce System** - Prevents replay attacks
- ✅ **Deadline Enforcement** - Transactions expire after 1 hour
- ✅ **DataHash Verification** - Ensures data integrity
- ✅ **Caller Validation** - Only authorized relayers can execute
- ✅ **Rate Limiting** - Prevents abuse
- ✅ **Gas Price Limits** - Avoids executing during high gas prices

## 🎯 How It Works

### Meta-Transaction Flow

```
1. User signs EIP-712 message (off-chain, free)
   ↓
2. Frontend sends signature + data to backend
   ↓
3. Relayer validates:
   - Signature ✓
   - Unique nonce ✓
   - Valid deadline ✓
   - Correct dataHash ✓
   - Caller authorized ✓
   ↓
4. Relayer estimates gas
   ↓
5. Relayer sends transaction (pays gas)
   ↓
6. Hub verifies signature on-chain
   ↓
7. Hub executes call to Storage contract
   ↓
8. Storage updates value
   ↓
9. Success! User sees confirmation
```

### EIP-712 Signature

The user signs a structured message (not a transaction):

```javascript
{
  from: "0x...",        // User's address
  to: "0x...",          // Storage contract
  value: 0,             // No ETH sent
  space: 1500,          // Namespace
  nonce: 1760120000,    // Unique number
  deadline: 1760123600, // Expiration time
  dataHash: "0x...",    // Hash of calldata
  caller: "0x...",      // Relayer address
  salt: "0x0000..."     // Extra randomness
}
```

This is verified on-chain by the Hub before execution.

## 📊 Gas Costs

| Operation | Gas Used | Cost (at 50 gwei) |
|-----------|----------|-------------------|
| Successful meta-tx | ~150,000 | ~0.0075 POL |
| Failed validation | ~32,000 | ~0.0016 POL |
| Direct call (without meta-tx) | ~50,000 | ~0.0025 POL |

**Note:** Meta-transactions cost more gas than direct calls, but users don't pay anything.

## 🚀 Deployment

### For Production

1. **Use a dedicated relayer wallet**
   - Create a new wallet specifically for relaying
   - Fund it with sufficient POL
   - Keep private key secure

2. **Set up monitoring**
   - Monitor relayer balance
   - Track transaction success rate
   - Set up alerts for errors

3. **Configure rate limiting**
   - Use Redis for distributed rate limiting
   - Adjust limits based on usage

4. **Secure the backend**
   - Use HTTPS
   - Add authentication if needed
   - Whitelist allowed origins (CORS)

5. **Deploy frontend**
   - Host `index.html` on a web server
   - Update `BACKEND_URL` to your server
   - Consider using a CDN

### Environment-Specific Configuration

```javascript
// Development
BACKEND_URL: 'http://localhost:3000'

// Production
BACKEND_URL: 'https://api.yourdomain.com'
```

## 🧪 Testing

### Manual Testing

1. **Connect wallet:** Should connect to Polygon Amoy
2. **View current value:** Should display stored number
3. **Store new value:** Should succeed without gas cost
4. **Check transaction:** Should appear on explorer
5. **Verify value updated:** Should show new number

### Health Check

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "relayer": "0x...",
  "balance": "0.5",
  "isAuthorized": true
}
```

## 📈 Monitoring

### Key Metrics to Track

1. **Relayer Balance** - Alert when < 0.01 POL
2. **Transaction Success Rate** - Should be > 95%
3. **Gas Usage** - Track average gas per transaction
4. **Response Times** - Monitor API latency
5. **Error Rate** - Track failed transactions

### Logs

The server provides detailed logs:

```
✅ = Success
❌ = Error
⚠️ = Warning
📋 = Transaction Hash
⛽ = Gas Information
```

## 🤝 Contributing

Contributions are welcome! To contribute:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-feature`
3. Commit changes: `git commit -m 'Add new feature'`
4. Push to branch: `git push origin feature/new-feature`
5. Open a Pull Request

## 📝 License

MIT License - see [LICENSE](./LICENSE) file for details.

## 🆘 Support

- **Issues:** Found a bug? [Open an issue](https://github.com/yourusername/repo/issues)
- **Documentation:** Full guides in [docs/](./docs)
- **Troubleshooting:** See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- **Quick Start:** See [QUICKSTART.md](./QUICKSTART.md)

## 🙏 Acknowledgments

- **Ethers.js** - Ethereum library
- **Express** - Web framework
- **MetaMask** - Web3 wallet
- **Polygon** - Amoy testnet

## 📚 Additional Resources

- [EIP-712 Specification](https://eips.ethereum.org/EIPS/eip-712)
- [Meta-Transactions Guide](https://docs.openzeppelin.com/learn/sending-gasless-transactions)
- [Polygon Amoy Faucet](https://faucet.polygon.technology/)
- [Amoy Explorer](https://amoy.polygonscan.com/)

---

**Built with ❤️ using Ethers.js, Express, and EIP-712**

**Version:** 2.0.1  
**Last Updated:** October 2025  
**Author:** Luis Ranieri Bocchi