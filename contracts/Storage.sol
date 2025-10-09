// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Storage
 * @dev Simple contract to store and retrieve a number
 */
contract Storage {
    uint256 private storedNumber;
    address public owner;
    
    event NumberStored(uint256 newNumber, address indexed storedBy);
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this function");
        _;
    }
    
    constructor() {
        owner = msg.sender;
    }
    
    /**
     * @dev Store a number
     * @param _number The number to store
     */
    function store(uint256 _number) public {
        storedNumber = _number;
        emit NumberStored(_number, msg.sender);
    }
    
    /**
     * @dev Retrieve the stored number
     * @return The stored number
     */
    function retrieve() public view returns (uint256) {
        return storedNumber;
    }
    
    /**
     * @dev Increment the stored number by 1 (only owner)
     */
    function increment() public onlyOwner {
        storedNumber += 1;
        emit NumberStored(storedNumber, msg.sender);
    }
    
    /**
     * @dev Reset the stored number to 0 (only owner)
     */
    function reset() public onlyOwner {
        storedNumber = 0;
        emit NumberStored(0, msg.sender);
    }
}