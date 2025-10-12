// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

//Important: remember to implement Oz Erc2771Context
contract Storage is ERC2771Context { 
    uint256 private storedNumber;
    address public owner;
    
    //Important: you need to use _msgSender() instead of msg.sender
    modifier onlyOwner() {
        require(_msgSender() == owner, "Only owner");
        _;
    }
    
    //Important: you need to pass the trusted forwarder address (PermissionedMetaTxHub) to the ERC2771Context constructor
    //also you need to set the contractOwner explicitly because on deployments sender always is the forwarder
    //if you dont what to use a contractOwner you can remove it and use "transferOwnership" to set it later
    constructor(address trustedForwarder, address contractOwner) ERC2771Context(trustedForwarder) {
      owner = contractOwner;
    }
    
    function store(uint256 _number) public {
        storedNumber = _number;
        emit NumberStored(_number, _msgSender());
    }
    event NumberStored(uint256 newNumber, address indexed storedBy);
    
    function retrieve() public view returns (uint256) {
        return storedNumber;
    }
    
    function increment() public onlyOwner {
        storedNumber += 1;
        emit NumberStored(storedNumber, _msgSender());
    }
    
    function reset() public onlyOwner {
        storedNumber = 0;
        emit NumberStored(0, _msgSender());
    }
    
    function transferOwnership(address newOwner) public onlyOwner {
        require(newOwner != address(0), "Invalid address");
        owner = newOwner;
    }
}