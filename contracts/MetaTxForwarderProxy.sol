// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title MetaTxForwarderProxy
/// @notice Proxy UUPS para MetaTxForwarder que permite upgrades controlados
/// @dev Utiliza el estándar ERC-1967 para storage de implementación
contract MetaTxForwarderProxy is ERC1967Proxy {
    /// @notice Constructor del proxy
    /// @param implementation Dirección del contrato de implementación inicial
    /// @param _data Datos de inicialización (calldata para el constructor/inicializador)
    constructor(
        address implementation,
        bytes memory _data
    ) ERC1967Proxy(implementation, _data) {}
}
