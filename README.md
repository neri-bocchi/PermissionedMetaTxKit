# PermissionedMetaTxKit

This project implements an advanced system for EIP-712 meta-transaction execution on Ethereum, featuring permission control, flexible nonce management, relayer allowlist, and per-block gas quotas. It includes smart contracts, deployment/admin scripts, and a client library.

## Project Structure

```
contracts/                  # Main Solidity contracts
deployments/                # Deployment metadata per network
meta-exec-lib/              # JS library for client/meta-tx
scripts/                    # Deployment and admin scripts
howToUse/                   # Usage examples for the library
test/                       # Example tests (Hardhat/Chai)
ignition/                   # Ignition deployment modules
```

## Main Contracts

- [`PermissionedMetaTxHub.sol`](contracts/PermissionedMetaTxHub.sol): Coordination hub for EIP-712 meta-transactions, relayer control, bitmap nonces, signature cancellation, ERC-1271 validation, and per-block gas quotas.
- [`Storage.sol`](contracts/Storage.sol): Example contract to store and retrieve a number, used for tests and demos.

## Installation

1. Clone the repository and enter the folder.
2. Install dependencies:

   ```sh
   npm install
   ```

3. Create a `.env` file with your keys and RPC:

   ```
   RPC_URL=...
   RELAYER_PK=...
   SENDER_PK=...
   HUB_ADDRESS=... # Address of deployed PermissionedMetaTxHub
   ```

## Contract Deployment

### Using Hardhat

- Deploy PermissionedMetaTxHub:

  ```sh
  npx hardhat run scripts/deployPermissionedMetaTxHub.js --network amoy
  ```

- Deploy Storage:

  ```sh
  npx hardhat run scripts/deployStorage.js --network amoy
  ```

- Deployment metadata is saved in [`deployments/`](deployments/).

### Using Ignition

Example for Lock:

```sh
npx hardhat ignition deploy ./ignition/modules/Lock.js
```

## Hub Administration

- **Relayer allowlist:**  
  Add an authorized relayer:

  ```sh
  node scripts/admin/setupCallerAllowlist.js
  ```

- **Per-block gas quota:**  
  Set the gas limit for a relayer:

  ```sh
  node scripts/admin/setupGasLimit.js [callerAddress] [limit]
  ```

- **Check gas usage:**  
  View current gas usage:

  ```sh
  node scripts/admin/checkGasUsage.js [callerAddress]
  ```

## Client Library: meta-exec-lib

The [`meta-exec-lib`](meta-exec-lib/src/index.js) library provides utilities to build, sign, and send EIP-712 meta-transactions compatible with [`PermissionedMetaTxHub.sol`](contracts/PermissionedMetaTxHub.sol).

### Main Functions

- [`buildCallData`](meta-exec-lib/src/index.js): Encodes the calldata for the target contract.
- [`prepareForward`](meta-exec-lib/src/index.js): Prepares the Forward struct and EIP-712 domain/types/message for signing.
- [`signForward`](meta-exec-lib/src/index.js): Signs the Forward struct using EIP-712.
- [`executeForward`](meta-exec-lib/src/index.js): Relayer executes the meta-transaction on-chain.

### Example Usage

See [`howToUse/sendTx.js`](howToUse/sendTx.js):

```js
import { ethers } from "ethers";
import { buildCallData, prepareForward, signForward, executeForward } from "./../meta-exec-lib/src/index.js";
import "dotenv/config";

async function run() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

  // User signs the meta-tx, relayer executes it
  const user    = new ethers.Wallet(process.env.SENDER_PK, provider);
  const relayer = new ethers.Wallet(process.env.RELAYER_PK, provider);

  // Addresses
  const metaAddress   = "0x094815651AEe2CC0ea2445C34fc327323165025a";
  const targetAddress = "0x98F6431E1CcdEc19087e3cE497275B2296fE46E7";

  // Prepare calldata for Storage.store(uint256)
  const random = Math.floor(Math.random() * 1000);
  const callData = buildCallData(["function store(uint256)"], "store", [random]);

  // Prepare Forward struct
  const space = 0;
  const userNonce = Math.floor(Math.random() * 1000);

  const prep = await prepareForward({
    provider,
    metaAddress,
    hasCaller: true,
    from: user.address,
    to: targetAddress,
    callData,
    caller: relayer.address,
    value: 0n,
    space: space,
    nonce: userNonce,
    deadlineSec: 24 * 60 * 60
  });

  // User signs the Forward struct
  const sig = await signForward(user, prep.domain, prep.types, prep.message);

  // Relayer executes the meta-tx
  const tx = await executeForward({
    provider,
    metaAddress,
    fTuple: prep.fTuple,
    callData: prep.callData,
    signature: sig,
    relayer,
    hasCaller: true
  });

  console.log("tx:", tx.hash);
  await tx.wait();
  console.log("store executed with user nonce:", userNonce.toString());
}

run().catch(console.error);
```

#### Typical Flow

1. **User** prepares and signs a meta-transaction using their private key.
2. **Relayer** receives the signed meta-tx and submits it to [`PermissionedMetaTxHub.sol`](contracts/PermissionedMetaTxHub.sol).
3. The hub contract validates the signature, nonce, relayer allowlist, and gas quota before executing the target contract call.

#### Advanced Features

- Supports out-of-order nonces (bitmap-based).
- Relayer allowlist for permissioned execution.
- Per-block gas quota enforcement.
- ERC-1271 contract signature validation.
- Meta-transaction cancellation via signature.

## Main Scripts

- [`deployPermissionedMetaTxHub.js`](scripts/deployPermissionedMetaTxHub.js): Deploys the hub and saves metadata.
- [`deployStorage.js`](scripts/deployStorage.js): Deploys Storage and tests basic functions.
- [`admin/setupCallerAllowlist.js`](scripts/admin/setupCallerAllowlist.js): Adds relayers to the allowlist. Set `.env` HUB_ADDRESS to the deployed PermissionedMetaTxHub address.
- [`admin/setupGasLimit.js`](scripts/admin/setupGasLimit.js): Sets gas limits.
- [`admin/checkGasUsage.js`](scripts/admin/checkGasUsage.js): Checks per-block gas usage.

## Network Nonce and Sequential Nonce Management Strategies

In addition to the flexible bitmap nonce system, the PermissionedMetaTxHub contract also supports a **network nonce** (sometimes called "global nonce" or "sequential nonce"). This is a monotonically increasing counter for each user, similar to the standard Ethereum transaction nonce.

### Network Nonce

- **Definition:**  
  The network nonce is an integer that increases with every successful meta-transaction for a user. It can be used for strictly sequential meta-transaction flows.
- **Usage:**  
  If you want to enforce strict ordering (i.e., meta-tx N+1 can only be executed after meta-tx N), you can always use the current network nonce for your next meta-transaction.
- **Retrieval:**  
  You can query the current network nonce for a user via a contract view function (e.g., `getNetworkNonce(address)`).

### Sequential Nonce Management Strategies

Depending on your application's needs, you can choose between bitmap nonces (out-of-order, parallel) and network nonces (sequential, ordered):

#### 1. Strict Sequential Flow

- Always use the current network nonce for each new meta-transaction.
- Wait for confirmation before preparing/signing the next meta-tx.
- Ensures that meta-transactions are executed in the exact order they were signed.

#### 2. Optimistic Sequential Flow

- Prepare and sign several meta-transactions in advance, each with incremented network nonce.
- Submit them in order, but if one fails, subsequent meta-txs will be rejected until the gap is resolved.
- Useful for batch operations where order matters.

#### 3. Parallel/Out-of-Order Flow (Bitmap Nonce)

- Assign arbitrary, unused bitmap nonces to each meta-transaction.
- Submit and execute meta-txs in any order.
- Ideal for workflows where transactions are independent and can be processed in parallel.

#### 4. Hybrid Strategy

- Use network nonce for critical, ordered operations.
- Use bitmap nonces for parallelizable or less critical actions.

### Example: Querying and Using Network Nonce

```js
// Query current network nonce from the contract
const currentNetworkNonce = await hubContract.getNetworkNonce(user.address);

// Use it for the next meta-tx
const prep = await prepareForward({
  // ...
  nonce: currentNetworkNonce,
  // ...
});
```

### Recommendations

- For most dApps, bitmap nonces offer maximum flexibility and parallelism.
- For financial or stateful operations requiring strict order, use the network nonce.
- Always track used nonces (bitmap or network) on the client side to avoid accidental replay or gaps.

For more details, see the contract's documentation and the client library usage examples.


## Contract Verification

After deployment, you can verify contracts on the block explorer:

```sh
npx hardhat verify --network amoy <contractAddress>
```

## Resources & References

- [PermissionedMetaTxHub.sol](contracts/PermissionedMetaTxHub.sol)
- [meta-exec-lib/src/index.js](meta-exec-lib/src/index.js)
- [deployPermissionedMetaTxHub.js](scripts/deployPermissionedMetaTxHub.js)
- [deployStorage.js](scripts/deployStorage.js)
- [howToUse/sendTx.js](howToUse/sendTx.js)

---

**Author:** Luis Ranieri Bocchi  
**License:** MIT