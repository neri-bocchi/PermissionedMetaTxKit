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

you can rename .env.example -> .env 

## Contract Deployment

### Using Hardhat

- Deploy PermissionedMetaTxHub:

  ```sh
  npx hardhat run scripts/deployPermissionedMetaTxHub.js --network amoy
  ```

- Deploy Storage:
  (first you need to allow your Relayer address on the PermissionedMetaTxHub, in this example both are the same but you can use differents Private-Keys)

  ```sh
  npx hardhat run scripts/deployStorage.js --network amoy
  ```

- Deployment metadata is saved in [`deployments/`](deployments/).


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
- [`hubAbi`](meta-exec-lib/src/index.js): PermissionedMetaTx ABI
  
### Example Usage

See [`howToUse/sendTx.js`](howToUse/sendTx.js):

```js
import { ethers } from "ethers";
import { buildCallData, prepareForward, signForward, executeForward } from "../meta-exec-lib/src/index.js";
import "dotenv/config";

const HUB_ADDRESS = process.env.HUB_ADDRESS;
const STORAGE_ADDRESS = "0x98F6431E1CcdEc19087e3cE497275B2296fE46E7"; // Update with your deployed Storage address

async function main() {
  // Setup
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const user = new ethers.Wallet(process.env.SENDER_PK, provider);
  const relayer = new ethers.Wallet(process.env.RELAYER_PK, provider);

  // Preparar datos
  const valueToStore = Math.floor(Math.random() * 1000);
  const callData = buildCallData(["function store(uint256)"], "store", [valueToStore]);

  const space = 1500;
  const nonce = Math.floor(Math.random() * 1000000);

  console.log(`📝 Storing value: ${valueToStore}`);
  console.log(`🔢 Using nonce: ${nonce}\n`);

  // Preparar meta-tx
  const prep = await prepareForward({
    provider,
    metaAddress: HUB_ADDRESS,
    domainName: "PermissionedMetaTxHub",
    domainVersion: "1",
    hasCaller: true,
    from: user.address,
    to: STORAGE_ADDRESS,
    callData,
    caller: relayer.address,
    value: 0n,
    space,
    nonce,
    deadlineSec: 24 * 60 * 60 // 24 horas
  });

  // Firmar
  const signature = await signForward(user, prep.domain, prep.types, prep.message);

  // Ejecutar
  console.log("📡 Sending meta-tx...");
  const tx = await executeForward({
    provider,
    metaAddress: HUB_ADDRESS,
    fTuple: prep.fTuple,
    callData: prep.callData,
    signature,
    relayer,
    hasCaller: true
  });

  console.log("Tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log(`✅ Mined in block ${receipt.blockNumber}\n`);
  console.log(`🎉 Store executed successfully!`);
}

main().catch(console.error);
```

#### DAPP Sample

This is an example of how to use PermissionedMetaTxHub on a DApp signing with Metamask

<p align="center">
  <img src="/howToUse/metamask/img/img1.png" width="100">
  <img src="/howToUse/metamask/img/img2.png" width="100">
  <img src="/howToUse/metamask/img/img4.png" width="100">
  <img src="/howToUse/metamask/img/img3.png" width="100">
</p>

How to create a DAPP with metamas sign EIP-712 and PermissionedMetaTxHub[`link`](/howToUse/metamask/readme.md)

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

## Nonce Management in PermissionedMetaTxHub

The `PermissionedMetaTxHub` contract implements a **bitmap-based nonce system** for meta-transactions, which is independent from the standard Ethereum network nonce.

### 1. RelayHub Nonce (Bitmap Nonce)

- **Purpose:**  
  Allows users to execute meta-transactions out of order and in parallel, with strong replay protection.
- **How it works:**  
  - Each `(user, space)` pair has a bitmap, where each bit represents a nonce (0, 1, 2, ...).
  - When a meta-transaction is executed or cancelled, its nonce bit is set using `_consumeNonce`.
  - The contract checks if a nonce is used via `isNonceUsed(address user, uint32 space, uint256 nonce)`.
  - Nonces can be arbitrary and do not need to be sequential.
- **Benefits:**  
  - Users can sign and submit multiple meta-transactions with different nonces, in any order.
  - Prevents replay attacks: once a nonce is used, it cannot be reused.
  - Supports parallel workflows and batch operations.

**Example:**  
If Alice signs meta-txs with nonces 1, 5, and 42 in space 0, she can submit them in any order. The contract will reject any attempt to reuse those nonces.

### 2. Network Nonce (Ethereum Transaction Nonce)

- **Purpose:**  
  Enforces strict sequential ordering of transactions sent directly by an Ethereum account.
- **How it works:**  
  - Every Ethereum account has a monotonically increasing nonce managed by the protocol.
  - Transaction N+1 cannot be mined until transaction N is confirmed.
- **Benefits:**  
  - Guarantees strict ordering of direct Ethereum transactions.
  - Prevents replay at the protocol level.

**Note:**  
The RelayHub nonce system is **independent** from the network nonce. Meta-transactions executed via PermissionedMetaTxHub do not consume the sender's Ethereum network nonce.

---

## Sequential Nonce Management Strategies for Meta-Transactions

If your application requires strict ordering (like the network nonce), you can implement your own strategies using the RelayHub's bitmap nonces:

### Strict Sequential Strategy

- Always use the next available nonce (e.g., highest used nonce + 1) for each new meta-transaction.
- Wait for confirmation before signing the next meta-tx.
- Ensures meta-transactions are executed in the exact order they were signed.

### Optimistic Sequential Strategy

- Sign several meta-txs with sequential nonces.
- Submit them in order; if one fails, subsequent ones will be rejected until the gap is resolved.
- Useful for batch operations where order matters.

### Parallel/Out-of-Order Strategy

- Assign arbitrary, unused bitmap nonces to each meta-transaction.
- Submit and execute meta-txs in any order.
- Ideal for workflows where transactions are independent and can be processed in parallel.

### Hybrid Strategy

- Use sequential nonces for critical, ordered operations.
- Use arbitrary nonces for parallelizable or less critical actions.

---

**Summary:**  
- The RelayHub nonce system is flexible and allows parallel, out-of-order meta-tx execution.
- The network nonce is strict and sequential, used for direct Ethereum transactions.
- You can implement sequential flows in RelayHub by managing nonces on the client side.

For more details, see the contract [`PermissionedMetaTxHub.sol`](contracts/PermissionedMetaTxHub.sol) and the client library usage examples.


## Contract Verification

After deployment, you can verify contracts on the block explorer:

```sh
npx hardhat verify --network amoy <contractAddress>
```

## Resources & References

- [PermissionedMetaTxHub.sol](contracts/PermissionedMetaTxHub.sol)
- [Storage.sol](contracts/Storage.sol)
- [meta-exec-lib/src/index.js](meta-exec-lib/src/index.js)
- [deployPermissionedMetaTxHub.js](scripts/deployPermissionedMetaTxHub.js)
- [deployStorage.js](scripts/deployStorage.js)
- [howToUse/sendTx.js](howToUse/sendTx.js)

---

**Author:** Luis Ranieri Bocchi  
**License:** MIT