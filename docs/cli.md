# CLI en Go — `pmtxhub`

Herramienta de línea de comandos en **Go** para **administrar y operar** el contrato
`PermissionedMetaTxHub` desde la terminal, sin necesidad de Node/Hardhat.

- **Ubicación:** `cli/` (módulo Go completo). El binario resultante es `pmtxhub`.
- **Dependencias:** [`cobra`](https://github.com/spf13/cobra) (comandos) + [`go-ethereum`](https://github.com/ethereum/go-ethereum) (cliente EVM).
- **Compatibilidad:** cualquier RPC EVM (Besu, Geth, LACNet, Polygon Amoy, etc.).
- Es el **equivalente en Go del flujo off-chain** que la librería JS (`meta-exec-lib/src/index.js`)
  realiza: cubre el ciclo completo de una meta-transacción **consultar → administrar → firmar → ejecutar**.

> **Nota sobre el nombre del contrato:** el CLI se refiere al contrato como `PermissionedMetaTxHub`
> (constante `DomainName` y dominio EIP-712), pero ese es el **nombre del producto/dominio**, no el del
> archivo de contrato. El **contrato de producción real es `contracts/MetaTxForwarder.sol`** — el ABI que
> usa el CLI (`allowedDeployers`, `setAllowedDeployer`, `deployGasWindowState`, `setDeployGasBucketConfig`,
> etc.) corresponde a `MetaTxForwarder.sol`. Ver la sección *Architecture* de `CLAUDE.md`.

> Nota: anteriormente existía una copia vieja `cli.go` en la raíz del repo; fue eliminada por estar
> desactualizada y no compilar (no había `go.mod` en la raíz). El módulo válido es **`cli/`**.

---

## Build

```sh
cd cli
go build -o pmtxhub
```

Versiones declaradas en `cli/go.mod`:

```
module cli
go 1.24.1

require (
    github.com/ethereum/go-ethereum v1.16.5
    github.com/spf13/cobra v1.10.1
)
```

---

## Configuración (flags y variables de entorno)

| Flag / Variable            | Uso                                                        |
|----------------------------|-----------------------------------------------------------|
| `--rpc` / `RPC_URL`        | Endpoint RPC del nodo EVM                                  |
| `--hub` / `HUB_ADDRESS`    | Dirección del contrato `PermissionedMetaTxHub`            |
| `OWNER_PRIVATE_KEY`        | PK del owner — requerida por los comandos `admin`         |
| `RELAYER_PRIVATE_KEY`      | PK del relayer — requerida por `execute`                  |
| `--pk` (flag de `sign`)    | PK del firmante (`from`) — requerida por `sign`           |

Constantes del dominio EIP-712 (fijas en el código):

- `DomainName = "PermissionedMetaTxHub"`
- `DomainVersion = "1"`

---

## Comandos

La CLI agrupa su funcionalidad en 5 grupos: `view`, `admin`, `sign`, `execute` y `chain`.

### 1. `view` — Consultas de estado (solo lectura)

Hacen `eth_call` y decodifican la respuesta con el ABI. **No firman ni gastan gas.**

| Comando | Función(es) del contrato | Devuelve |
|---------|--------------------------|----------|
| `view caller <address>` | `isCallerAllowed`, `gasLimitPerBlock`, `gasUsedThisBlock` | Si el relayer está allowlisted, su límite de gas por bloque configurado, y el runtime `{ used, limit, blockNo }` |
| `view deploy-window <from>` | `deployGasWindowState` | Ventana de gas para deploys CREATE: `{ used, limit, startedAt, duration, now, remaining }` |
| `view flags` | `erc2771AppendSender`, `gasAccountingOverhead` | Flag ERC-2771 y overhead de contabilidad de gas |
| `view allowed-deployer <addr>` | `allowedDeployers` | Si una dirección puede desplegar |
| `view digest <0x..32>` | `usedDigest` | Si un digest ya fue consumido (protección de replay) |

Ejemplos:

```sh
./pmtxhub view caller 0xRELAYER
./pmtxhub view deploy-window 0xSENDER
./pmtxhub view flags
./pmtxhub view allowed-deployer 0xDEPLOYER
./pmtxhub view digest 0x1234...  # bytes32
```

### 2. `admin` — Funciones `onlyOwner`

Envían transacciones de configuración firmadas con `OWNER_PRIVATE_KEY`. Internamente usan el
helper `withOwnerTx`, que carga la PK del owner, deriva el `from`, obtiene el `chainId` y firma/envía.

| Comando | Función del contrato |
|---------|----------------------|
| `admin set-caller <addr> <true\|false>` | `setCallerAllowed` |
| `admin set-gaslimit <addr> <limit>` | `setGasLimitPerBlock` |
| `admin set-overhead <n>` | `setGasAccountingOverhead` |
| `admin set-erc2771 <true\|false>` | `setErc2771AppendSender` |
| `admin set-deploy-bucket <limit> <durationSeconds>` | `setDeployGasBucketConfig` |
| `admin set-allowed-deployer <addr> <true\|false>` | `setAllowedDeployer` |
| `admin set-allowed-deployers <file.json> <true\|false>` | `setAllowedDeployers` (lote) |

El comando de lote lee un archivo JSON con un array de direcciones, p. ej.:

```json
["0xAAA...", "0xBBB...", "0xCCC..."]
```

Ejemplos:

```sh
export OWNER_PRIVATE_KEY=<pk-sin-0x-o-con-0x>
./pmtxhub admin set-caller 0xRELAYER true
./pmtxhub admin set-gaslimit 0xRELAYER 5000000
./pmtxhub admin set-deploy-bucket 30000000 86400
./pmtxhub admin set-allowed-deployers deployers.json true
```

### 3. `sign` — Firma EIP-712 del `Forward` (rol del usuario/sender)

Construye el typed data y firma con la PK del `from`. Genera por stdout un **JSON `SignedPackage`**
(meta-tx firmada) que luego consume `execute`.

Pasos internos:

1. Arma el dominio EIP-712 (`PermissionedMetaTxHub` v1 + `verifyingContract` = hub) con el `chainId` del RPC.
2. Define el tipo `Forward` de **8 campos**: `from, to, value, space, nonce, deadline, dataHash, caller`.
3. Calcula `dataHash = keccak256(data)`.
4. Firma con `crypto.Sign` y ajusta `v` a 27/28.
5. Emite el JSON `{ domain, forward, data, signature }`.

Flags:

| Flag | Descripción |
|------|-------------|
| `--from` | Dirección del firmante (sender real de la meta-tx) — **requerido** |
| `--to` | Destino; `0x0` para hacer un deploy CREATE — **requerido** |
| `--value` | Valor en ETH, o en wei si el string contiene `wei` (p. ej. `1000000000000000000wei`) |
| `--space` | Espacio del nonce (uint32) |
| `--nonce` | Nonce (uint256) |
| `--deadline` | Deadline en segundos unix |
| `--caller` | Relayer autorizado — **requerido** |
| `--data` | Calldata/bytecode en hex |
| `--pk` | PK del `from` — **requerido** |

Ejemplo:

```sh
./pmtxhub sign \
  --from 0xA --to 0xB --space 0 --nonce 1 \
  --deadline 1924999999 --caller 0xRELAYER \
  --data 0x... --pk 0x... > forward.json
```

> El `dataHash` se firma sobre el calldata **antes** de cualquier append de ERC-2771 que haga el contrato.

### 4. `execute` — Envía la meta-tx on-chain (rol del relayer)

Lee el JSON producido por `sign` y llama a `execute()` en el hub, firmando con `RELAYER_PRIVATE_KEY`.

Pasos internos:

1. Lee y deserializa el `SignedPackage`.
2. **Re-valida la integridad:** comprueba que `keccak256(data) == forward.dataHash` (aborta si no coincide).
3. Reconstruye el tuple `Forward` y empaqueta `abiHub.Pack("execute", forward, data, signature)`.
4. Estima gas, obtiene el nonce de red del relayer, firma y hace `SendTransaction`.
5. Imprime el tx hash.

Flags:

| Flag | Descripción |
|------|-------------|
| `--forward` | Ruta al archivo JSON (salida de `sign`) — **requerido** |
| `--value` | Override opcional del value en wei |

Ejemplo:

```sh
export RELAYER_PRIVATE_KEY=<pk>
./pmtxhub execute --forward forward.json
```

### 5. `chain` — Diagnóstico

Imprime el `chainId` del RPC y la dirección del hub configurada.

```sh
./pmtxhub chain
# { chainId: 80002, hub: 0x... }
```

---

## Estructuras de datos clave

### Tuple `Forward` (Go)

Debe mantener el **mismo orden y tipos** que el `Forward` del contrato:

```go
type Forward struct {
    From     common.Address
    To       common.Address
    Value    *big.Int
    Space    uint32
    Nonce    *big.Int
    Deadline *big.Int
    DataHash [32]byte
    Caller   common.Address
}
```

### `SignedPackage` (JSON de intercambio entre `sign` y `execute`)

```json
{
  "domain":   { "name": "...", "version": "1", "chainId": "...", "verifyingContract": "0x..." },
  "forward":  { "from": "0x...", "to": "0x...", "value": "0", "space": 0,
                "nonce": "1", "deadline": "...", "dataHash": "0x...", "caller": "0x..." },
  "data":     "0x...",
  "signature":"0x..."
}
```

---

## Consistencia con el resto del sistema

El ABI embebido en el CLI (`hubABIJSON`) y el tipo `Forward` deben mantenerse **byte-a-byte**
sincronizados con:

- El `FORWARD_TYPEHASH` y la firma de `execute` en `contracts/MetaTxForwarder.sol`.
- Los `types` / `fTuple` de `prepareForward` y el `META_ABI` / `EXECUTE_SIG` en `meta-exec-lib/`.

Cualquier cambio en la estructura `Forward` (campos, orden, tipos) obliga a actualizar **las tres**
implementaciones (contrato, librería JS y este CLI) o las firmas EIP-712 dejarán de validar.
