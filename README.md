# PermissionedMetaTxKit

Este proyecto implementa un sistema avanzado para la ejecución de meta-transacciones EIP-712 en Ethereum, con control de permisos, gestión flexible de nonces, allowlist de relayers y cuotas de gas por bloque. Incluye contratos inteligentes, scripts de administración/despliegue y una librería para clientes.

## Estructura del proyecto

```
contracts/                  # Contratos Solidity principales
deployments/                # Metadatos de despliegue por red
meta-exec-lib/              # Librería JS para clientes/metatx
scripts/                    # Scripts de despliegue y administración
howToUse/                   # Ejemplos de uso de la librería
test/                       # Tests de ejemplo (Hardhat/Chai)
ignition/                   # Módulos de despliegue Ignition
```

## Contratos principales

- [`PermissionedMetaTxHub.sol`](contracts/PermissionedMetaTxHub.sol): Hub de coordinación de meta-transacciones con EIP-712, control de relayers, nonces bitmap, cancelación de firmas, validación ERC-1271 y cuotas de gas por bloque.
- [`Storage.sol`](contracts/Storage.sol): Contrato de ejemplo para almacenar y recuperar un número, usado en pruebas y ejemplos.

## Instalación

1. Clona el repositorio y entra en la carpeta.
2. Instala dependencias:

   ```sh
   npm install
   ```

3. Crea un archivo `.env` con tus claves y RPC:

   ```
   RPC_URL=...
   RELAYER_PK=...
   SENDER_PK=...
   HUB_ADDRESS=... # Dirección del PermissionedMetaTxHub desplegado
   ```

## Despliegue de contratos

### Usando Hardhat

- Desplegar PermissionedMetaTxHub:

  ```sh
  npx hardhat run scripts/deployPermissionedMetaTxHub.js --network amoy
  ```

- Desplegar Storage:

  ```sh
  npx hardhat run scripts/deployStorage.js --network amoy
  ```

- Los metadatos de despliegue se guardan en [`deployments/`](deployments/).

### Usando Ignition

Ejemplo para Lock:

```sh
npx hardhat ignition deploy ./ignition/modules/Lock.js
```

## Administración del Hub

- **Allowlist de relayers:**  
  Añade el relayer autorizado con:

  ```sh
  node scripts/admin/setupCallerAllowlist.js
  ```

- **Cuota de gas por bloque:**  
  Configura el límite de gas por bloque para un relayer:

  ```sh
  node scripts/admin/setupGasLimit.js [callerAddress] [limit]
  ```

- **Consulta de uso de gas:**  
  Verifica el consumo de gas actual:

  ```sh
  node scripts/admin/checkGasUsage.js [callerAddress]
  ```

## Uso de la librería meta-exec-lib

La librería [`meta-exec-lib`](meta-exec-lib/src/index.js) permite construir, firmar y enviar meta-transacciones EIP-712.

Ejemplo de uso:  
Ver [`howToUse/sendTx.js`](howToUse/sendTx.js):

```js
import { buildCallData, prepareForward, signForward, executeForward } from "./../meta-exec-lib/src/index.js";
// ...ver ejemplo completo en el archivo...
```

## Scripts principales

- [`deployPermissionedMetaTxHub.js`](scripts/deployPermissionedMetaTxHub.js): Despliega el hub y guarda metadatos.
- [`deployStorage.js`](scripts/deployStorage.js): Despliega Storage y prueba funciones básicas.
- [`admin/setupCallerAllowlist.js`](scripts/admin/setupCallerAllowlist.js): Añade relayers a la allowlist.
- [`admin/setupGasLimit.js`](scripts/admin/setupGasLimit.js): Configura límites de gas.
- [`admin/checkGasUsage.js`](scripts/admin/checkGasUsage.js): Consulta uso de gas por bloque.

## Tests

Ejemplo de test en [`test/Lock.js`](test/Lock.js) usando Hardhat y Chai.

```sh
npx hardhat test
```

## Verificación de contratos

Tras el despliegue, puedes verificar los contratos en el block explorer:

```sh
npx hardhat verify --network amoy <contractAddress>
```

## Recursos y referencias

- [PermissionedMetaTxHub.sol](contracts/PermissionedMetaTxHub.sol)
- [meta-exec-lib/src/index.js](meta-exec-lib/src/index.js)
- [deployPermissionedMetaTxHub.js](scripts/deployPermissionedMetaTxHub.js)
- [deployStorage.js](scripts/deployStorage.js)
- [howToUse/sendTx.js](howToUse/sendTx.js)

---

**Autor:** Luis Ranieri Bocchi  
**Licencia:** MIT
