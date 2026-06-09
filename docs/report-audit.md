# Reporte de auditoría — `MetaTxForwarder.sol`

- **Contrato:** `contracts/MetaTxForwarder.sol` (EIP-712 + Ownable + ReentrancyGuard)
- **Rama:** `feature/refactory`
- **Compilador:** Solidity 0.8.24 · optimizer 200 · `viaIR` · `bytecode_hash = none` · `evm_version = paris`
- **Metodología:** flujo de desarrollo seguro de Trail of Bits (5 pasos) + revisión manual + PoC ejecutable en Foundry
- **Fecha:** 2026-06-08

---

## Resumen ejecutivo

| Sev | ID | Hallazgo | Estado |
|-----|----|----------|--------|
| 🔴 High | H-1 | Bypass total de los controles de deploy vía `DeployProxy` (`f.to = address(_deployProxy)`) | **Probado (PoC)** |
| 🟡 Low | L-1 | `_executeCall` reenvía todo el gas; la cuota por bloque es post-facto | Revisión manual |
| 🟡 Low | L-2 | `DeployGasExceeded` mal atribuido cuando el constructor revierte sin data | Revisión manual |
| 🟡 Low | L-3 | `CREATE` con nonce compartido → dirección no determinista / front-running | Revisión manual |
| ⚪ Info | I-1 | `setDeployersBucketConfig` usa `require`-string en vez de custom error | Revisión manual |
| ⚪ Info | I-2 | Ruta ERC-1271 se activa con `code.length > 0` (considerar EIP-7702) | Revisión manual |
| ⚪ Info | I-3 | Self-call `f.to == address(this)` hoy seguro; conviene guard explícito | Revisión manual |

**Sin hallazgos** en: protección de replay, reentrancy, malleabilidad de firma, validación de `msg.value`, binding del relayer y escalada de privilegios a funciones `onlyOwner`. Detalle en la sección "Áreas revisadas sin hallazgos".

---

## Estado del tooling (transparencia)

- **Slither: NO ejecutado.** No se pudo instalar en este entorno:
  - `pip install slither-analyzer` falla compilando la wheel de `cbor2`; no hay `pipx`.
  - `solc-select install 0.8.24` está bloqueado por red (HTTP 403). El `solc` del sistema es 0.6.x.
- **Compensación:** revisión manual completa (pasos 3–5 del flujo ToB) + **PoC ejecutable en Foundry** (`solc 0.8.24` disponible vía Foundry) para el hallazgo crítico.
- **Pendiente** para un entorno con la toolchain instalada: detectores Slither, `slither-check-upgradeability`, `slither-check-erc`, grafos PNG y propiedades Echidna.

---

## 🔴 H-1 — Bypass total de los controles de deploy vía `DeployProxy` (PROBADO)

**Ubicación:** `execute` → `_executeCall` (líneas 555–559, 710–730) + `DeployProxy.deploy` (línea 39).

### Descripción

El hub gatea los deploys (allowlist `allowedDeployers`, 1 deploy por bloque por `from`, bucket de gas por deployer, cap de 5M y acotamiento de gas del fix **H-02**) **únicamente en la ruta `_executeCreate`**, que se toma cuando `f.to == address(0)`.

Sin embargo, `DeployProxy.deploy()` solo se protege con:

```solidity
if (msg.sender != _hub) revert();
```

Cuando un forward firmado pone **`f.to = address(_deployProxy)`**, se toma la ruta genérica `_executeCall`, que ejecuta:

```solidity
success := call(gas(), target, value, ptr, len, 0, 0)
```

con `msg.sender == address(this) == _hub`. El check de `DeployProxy` pasa y se ejecuta `create()` con bytecode arbitrario, **saltándose todos los controles de deploy**:

- ❌ `allowedDeployers` — el firmante NO necesita estar permitido
- ❌ límite de 1 deploy por bloque por `from`
- ❌ bucket de gas por deployer
- ❌ cap de 5M y el acotamiento de gas de **H-02** (`_executeCall` reenvía *todo* el gas con `call(gas(), …)`, reintroduciendo el gas-griefing al relayer que H-02 buscaba cerrar)

### Por qué es explotable

- La dirección de `_deployProxy` es derivable: `CREATE(hub, nonce = 1)`. No hay seguridad por oscuridad.
- El firmante controla `data` por completo (`dataHash = keccak256(data)`).
- El append ERC-2771 de 20 bytes **no** rompe el decode de `deploy(bytes)`: los bytes sobrantes al final del calldata son ignorados por el decoder ABI.
- Solo se requiere que **cualquier** relayer allowlisteado retransmita la meta-tx, que es exactamente su función.

### Impacto

La capa `allowedDeployers` / bucket de gas (el rasgo que distingue al contrato de producción según `CLAUDE.md`) queda anulada. Cualquier firmante puede desplegar contratos arbitrarios a través del hub y se reabre el vector de griefing de gas que cerraba H-02.

### Prueba de concepto

Archivo: `test/foundry/PoC_DeployProxyBypass.t.sol`

- `test_Control_LegitDeployPathRejectsNonAllowedDeployer` — confirma que la ruta legítima (`f.to == address(0)`) revierte con `DeployerNotAllowed` para un firmante no permitido.
- `test_Exploit_DeployViaProxyBypassesAllowlist` — el mismo firmante **no permitido** despliega un contrato `Dummy` ruteando por el proxy, y se verifica que `getDeployerInfo().lastDeployBlock == 0` (ningún control de deploy llegó a ejecutarse).

```
[PASS] test_Control_LegitDeployPathRejectsNonAllowedDeployer()
[PASS] test_Exploit_DeployViaProxyBypassesAllowlist()
```

### Remediación

En `execute`, antes del dispatch (`if (f.to == address(0))`):

```solidity
if (f.to == address(_deployProxy) || f.to == address(this)) revert UnexpectedCaller();
```

Defensa en profundidad adicional: dar a `DeployProxy` un flag/nonce transitorio que solo permita `deploy()` cuando lo invoca `_executeCreate` (no `_executeCall`).

Tras aplicar el fix, convertir `test_Exploit_DeployViaProxyBypassesAllowlist` en test de regresión con `vm.expectRevert` (debe pasar a revertir).

---

## 🟡 L-1 — `_executeCall` reenvía todo el gas; la cuota por bloque es post-facto

**Ubicación:** `_executeCall` (línea 721) + `_enforceAndConsumeCallerGas` (líneas 772–783).

`call(gas(), …)` reenvía todo el gas restante a un `f.to` arbitrario. La cuota por bloque se aplica **después** de la ejecución; al excederse revierte la transacción y **no** persiste el contador, así que solo acota el daño por transacción, no refunda el gas del relayer. Es un riesgo inherente al patrón meta-tx (los relayers simulan antes de enviar), pero conviene exponer un cap de gas por llamada opcional.

---

## 🟡 L-2 — `DeployGasExceeded` mal atribuido

**Ubicación:** `_executeCreate` (líneas 680–681).

```solidity
if (!ok) {
    if (ret.length == 0) revert DeployGasExceeded(); // el sub-call agotó el gas
    ...
}
```

Un constructor que hace `revert()` sin datos produce `ret.length == 0` y se reporta como `DeployGasExceeded`, ocultando la causa real (constructor revert vs. out-of-gas). Solo afecta a la observabilidad del error, no a la seguridad.

---

## 🟡 L-3 — `CREATE` con nonce compartido → dirección no determinista

**Ubicación:** `DeployProxy.deploy` (línea 42).

Se usa `CREATE` (no `CREATE2`) con el nonce **compartido** del `_deployProxy`. La dirección del contrato desplegado depende del orden global de deploys, así que el front-running puede cambiarla. Si un cliente off-chain predice la dirección desplegada, es un foot-gun; `CREATE2` con salt daría determinismo.

---

## ⚪ Informativos

- **I-1 — Inconsistencia de errores.** `setDeployersBucketConfig` (línea 289) usa `require(..., "Length mismatch")` mientras el resto del contrato usa custom errors.
- **I-2 — ERC-1271 y EIP-7702.** `_validateSignature` (línea 738) activa la ruta ERC-1271 con `code.length > 0`. Con EIP-7702 una EOA puede tener código y cambiar de rama de validación; tenerlo presente en el modelo de amenazas.
- **I-3 — Self-call.** `f.to == address(this)` hoy es seguro (`onlyOwner` usa `msg.sender` = hub ≠ owner; `execute`/`cancel` son `nonReentrant`), pero el guard propuesto en H-1 lo blinda explícitamente.

---

## Áreas revisadas sin hallazgos

| Área | Resultado |
|------|-----------|
| Replay protection | Doble protección `usedDigest[digest]` + bitmap de nonces; escrituras de estado **antes** del call externo (CEI). ✅ |
| Reentrancy | `nonReentrant` en `execute` y `cancel`; el constructor del contrato desplegado no puede reentrar. ✅ |
| Malleabilidad de firma | OZ `ECDSA.recover` rechaza `s` alta y `address(0)`. ✅ |
| `msg.value` | Verificado antes de cualquier escritura de estado (fix M-03). ✅ |
| Binding del relayer | `f.caller == msg.sender` firmado → la meta-tx queda ligada a un relayer concreto. ✅ |
| Escalada de privilegios | Llamar funciones `onlyOwner` vía meta-tx falla: `msg.sender` interno = hub ≠ owner. ✅ |
| Recuperación de ETH | `withdraw` onlyOwner (fix H-01). ✅ |
| Cancelación por firma | `cancel` exige firma EIP-712 de `req.from`; rate-limit directo (NC-03). ✅ |

---

## Pasos pendientes del flujo Trail of Bits (requieren toolchain)

- [ ] **Paso 1 — Slither:** `slither .` con los 70+ detectores. *Bloqueado por instalación.*
- [ ] **Paso 2 — Features especiales:** `slither-check-upgradeability` (N/A: sin proxy upgradeable), `slither-check-erc`.
- [ ] **Paso 3 — Inspección visual:** grafos de herencia, function-summary y variables-y-autorización.
- [ ] **Paso 4 — Propiedades:** invariantes Echidna, p.ej. *"un `from` ∉ `allowedDeployers` nunca despliega"* (invariante que H-1 viola).
- [ ] **Paso 5 — Revisión manual:** completada (este reporte).

---

## Acción inmediata recomendada

1. Aplicar el fix de **H-1** (guard sobre `f.to`).
2. Convertir el PoC de exploit en test de regresión (`vm.expectRevert`).
3. Ejecutar Slither + Echidna en un entorno con la toolchain para cerrar los pasos 1–4.
