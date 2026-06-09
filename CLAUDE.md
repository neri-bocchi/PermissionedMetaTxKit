# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

PermissionedMetaTxKit is an EIP-712 meta-transaction system for EVM chains. A user signs a `Forward` struct off-chain; an allowlisted relayer submits it to the on-chain hub, which validates the signature, nonce, relayer permission, and gas quota before executing the target call. The repo contains the Solidity contracts, Hardhat deployment/admin scripts, a JS client library, and a Go admin CLI.

The codebase is bilingual — much of the code, comments, and README prose is in Spanish. Match the surrounding language when editing.

## Commands

This is an ESM project (`"type": "module"` in package.json) — scripts use `import`, not `require`.

```sh
npm install                                                          # install deps
npx hardhat compile                                                  # compile contracts
npx hardhat test                                                     # run tests (note: test/*.test.js are currently empty stubs)
npx hardhat test test/PermissionedMetaTxHub.test.js                 # run a single test file
npx hardhat run scripts/deployMetaTxForwarder.js --network amoy        # deploy the production hub (MetaTxForwarder.sol)
npx hardhat run scripts/deployStorage.js --network amoy             # deploy the example Storage contract
npx hardhat verify --network amoy <contractAddress>                 # verify on block explorer
```

`package.json`'s `npm test` is a placeholder that errors — always use `npx hardhat test`.

### Foundry (coexists with Hardhat)

Foundry handles **compile + Solidity testing**, and **deploy on EVM-standard networks (amoy)**. Hardhat keeps **deploy/verify on LACNet** (lnettest/lnetmain — `gasPrice 0` + legacy `type 0`, where `forge` fails), the existing JS tests, and is what the admin scripts/CLI ecosystem assumes.

```sh
forge build                                                          # compile contracts/ (out/, cache_forge/)
forge test -vv                                                       # run Solidity tests in test/foundry/*.t.sol
forge script script/DeployMetaTxForwarder.s.sol:DeployMetaTxForwarder \
  --rpc-url amoy --private-key 0x$RELAYER_PK --broadcast --verify    # deploy hub on amoy (Foundry)
```

`foundry.toml` mirrors `hardhat.config.js`'s compiler settings exactly — **including `evm_version = "paris"`** (Hardhat 2.x's default; *not* solc 0.8.24's `shanghai`). This was verified: `MetaTxForwarder`/`Storage` runtime bytecode is byte-identical under both tools. Changing `evm_version` (or any compiler setting) in one file without the other will make deployed/verified bytecode diverge. OpenZeppelin is shared via `remappings.txt` → `node_modules` (single source of truth); `forge-std` is a git submodule in `lib/`. Foundry deploy scripts live in `script/` (singular) — distinct from the node scripts in `scripts/` (plural). Private keys in `.env` lack the `0x` prefix, so `forge` invocations prepend it (`0x$RELAYER_PK`).

Admin scripts under `scripts/admin/` are plain node scripts (not `hardhat run`), e.g.:
```sh
node scripts/admin/setupCallerAllowlist.js <relayerAddress>   # allowlist a relayer (owner-only)
node scripts/admin/setupGasLimit.js <callerAddress> <limit>   # set per-block gas quota
node scripts/admin/checkGasUsage.js <callerAddress>           # read current gas usage
```

Go CLI (`cli/` is the full module) — full reference in [`docs/cli.md`](docs/cli.md):
```sh
cd cli && go build -o pmtxhub
./pmtxhub view caller 0xRELAYER
./pmtxhub admin set-caller 0xRELAYER true
```

## Environment

Scripts read config from `.env` (copy `.env.example`). Per-network presets exist as `.env.amoy`, `.env.lnettest`, `.env.lnetmain`. Key vars: `RPC_URL`, `RELAYER_PK` (used for both deploy and relaying in examples), `SENDER_PK` (signs meta-txs), `HUB_ADDRESS`, `OWNER_PRIVATE_KEY` (Go CLI admin). Private keys are stored **without** the `0x` prefix.

## Architecture

### The hub: `contracts/MetaTxForwarder.sol`

**`MetaTxForwarder.sol` is the production/final contract** (`EIP712 + Ownable + ReentrancyGuard`) — confirmed by the developer and by the fact that the entire `scripts/admin/` suite and the Go CLI target its ABI (see below), and that it carries the audit fixes (`FIX H-02`, `FIX M-01`). When working on meta-tx logic, target `MetaTxForwarder.sol` unless told otherwise. `Storage.sol` is only a demo target for tests.

> Earlier variants were removed during cleanup: `MetaTxForwarderv1.sol` (the first forwarder generation); the abandoned UUPS branch (`MetaTxForwarderUpgradeable.sol` + `MetaTxForwarderProxy.sol` + `scripts/deploy-proxy.js` + `scripts/upgrade-proxy.js`); and `PermissionedMetaTxHub.sol` + `scripts/deployPermissionedMetaTxHub.js` (a reduced version lacking the deployer-allowlist / gas-bucket layer and the audit fixes). All were strict subsets of `MetaTxForwarder.sol` predating its audit fixes; their `Forward`/`FORWARD_TYPEHASH` were identical, so off-chain signing clients are unaffected by their removal.

> **Naming trap:** the production contract declares its EIP-712 domain as `EIP712("PermissionedMetaTxHub", "1")`. So `"PermissionedMetaTxHub"` is the product/domain name (shared by the now-removed contract family), **not** an identifier of a specific contract file — the off-chain clients (`meta-exec-lib`, Go CLI) and tests sign/reference with that domain name regardless of the file. What distinguishes the production contract is its **function ABI** (the deployer/bucket layer below), not the domain string.

`execute(Forward f, bytes data, bytes signature)` enforces, in order:
1. **Caller allowlist** — `msg.sender` must be in `isCallerAllowed`, and `f.caller` must equal `msg.sender`. The relayer is trusted and powerful by design.
2. **Deadline** and **dataHash integrity** — `keccak256(data) == f.dataHash`.
3. **Signature** via `_validateSignature`: EOA path uses `ECDSA.recover`; if `f.from` has code, it uses the ERC-1271 `isValidSignature` path.
4. **Replay protection** — both a `usedDigest[digest]` flag and the bitmap nonce.
5. **ETH value** — `msg.value == f.value`.
6. **Dispatch** — `f.to == address(0)` does a `CREATE` deploy (`_executeCreate`, which delegates to an auxiliary `DeployProxy` contract deployed in the constructor — `FIX H-02`); otherwise `_executeCall`.
7. **Per-block gas quota** — `_enforceAndConsumeCallerGas` charges measured gas + `gasAccountingOverhead` against the caller's `gasLimitPerBlock`, resetting the counter each new block.

**Deployer allowlist & gas buckets (production-only):** beyond the per-caller gas quota, `MetaTxForwarder` gates CREATE deploys through a separate `allowedDeployers` allowlist and a per-deployer gas-bucket window (default bucket + per-deployer overrides via `setDeployerBucketConfig`). `getDeployerInfo` / `deployGasWindowState` expose the live state. This whole layer is what `scripts/admin/` and the Go CLI operate on.

**Bitmap nonces:** nonces are `(user, space, nonce)` triples stored as bits (`noncesUsed[user][space][word] & mask`, where `word = nonce >> 8`, `bit = nonce & 0xff`). This allows arbitrary, out-of-order, parallel nonces — independent of the Ethereum network nonce. Sequential ordering, if needed, must be enforced client-side.

**ERC-2771:** when `erc2771AppendSender` is true (default), `_executeCall` appends the 20-byte `f.from` to the calldata so the target can recover the real sender. The signed `dataHash` is over the calldata *before* this append.

**Gas-griefing protection:** return data copied from external calls/creates is capped at `MAX_RETURN_DATA_SIZE` (1024 bytes) in inline assembly.

`cancelWithSig` lets a signer burn a `(space, nonce)` via a signed `Cancel` message, consuming the bitmap bit without executing.

### Client library: `meta-exec-lib/src/index.js`

The off-chain counterpart to the hub. Pipeline: `buildCallData` (encode the target call) → `prepareForward` (assemble the EIP-712 domain/types/message + `fTuple`) → `signForward` (sign typed data) → `executeForward` (relayer sends `execute`). `getDeployedAddress` parses the `ContractDeployed` event for CREATE meta-txs. `setLogging(true)` enables verbose internal logging (off by default).

The EIP-712 `Forward` type and the `execute` selector must stay byte-for-byte in sync across three places: the `FORWARD_TYPEHASH` in the contract, the `types`/`fTuple` in `prepareForward`, and `META_ABI`/`EXECUTE_SIG` in `meta-exec-lib/src/abis.js`. Changing the struct means updating all three. `hasCaller` toggles between the 8-field (with `caller`) and 7-field forms — the contract expects the 8-field form.

### Compiler settings (`hardhat.config.js`)

Solidity `0.8.24`, optimizer 200 runs, **`viaIR: true`**, and **`metadata.bytecodeHash: "none"`**. The deploy script logs the runtime bytecode keccak; the no-metadata-hash setting is deliberate so deployed bytecode is reproducible — preserve these settings or deployed/verified bytecode will diverge. Networks: `amoy` (Polygon Amoy, 80002), `lnettest` (648540), `lnetmain` (648541); the LACNet networks run with `gasPrice: 0` and legacy `type: 0` transactions.

### Other directories

- `howToUse/` — runnable usage examples, including a MetaMask DApp walkthrough (`howToUse/metamask/`).
- `deployments/` — per-network deployment metadata JSON written by the deploy scripts.
- `audit.md` — security audit notes for the hub.
- `docs/cli.md` — full reference for the Go admin CLI (`cli/pmtxhub`).
