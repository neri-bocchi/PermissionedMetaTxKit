// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA}                from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712Upgradeable}    from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {IERC1271}             from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {OwnableUpgradeable}   from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable}      from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {EnumerableSet}        from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title MetaTxForwarderUpgradeable (ERC-2771 compatible + UUPS)
/// @author Luis
/// @notice Hub on-chain para meta-txs EIP-712 con soporte de upgrades
/// @dev Versión upgradeable usando UUPS pattern
contract MetaTxForwarderUpgradeable is 
    EIP712Upgradeable, 
    OwnableUpgradeable, 
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable 
{
    using ECDSA for bytes32;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ========= Constants =========
    uint256 private constant MAX_RETURN_DATA_SIZE = 1024;
    uint256 private constant DEPLOY_GAS_LIMIT = 5_000_000;

    // ========= EIP-712 =========
    bytes32 private constant FORWARD_TYPEHASH = keccak256(
        "Forward(address from,address to,uint256 value,uint32 space,uint256 nonce,uint256 deadline,bytes32 dataHash,address caller)"
    );
    bytes32 private constant CANCEL_TYPEHASH = keccak256(
        "Cancel(address from,uint32 space,uint256 nonce,uint256 deadline)"
    );

    // ========= Storage =========
    mapping(address => mapping(uint32 => mapping(uint256 => uint256))) private noncesUsed;
    mapping(bytes32 => bool) public usedDigest;
    mapping(address => bool) public isCallerAllowed;
    EnumerableSet.AddressSet private _allowedCallers;
    mapping(address => uint256) public gasLimitPerBlock;
    mapping(address => uint256) private _gasUsedThisBlock;
    mapping(address => uint64)  private _lastBlockForCaller;
    uint256 public gasAccountingOverhead;
    bool public erc2771AppendSender;
    mapping(address => bool) public allowedDeployers;
    EnumerableSet.AddressSet private _allowedDeployersSet;
    mapping(address => uint256) private _lastDeployBlockByFrom;
    uint256 public defaultDeployGasBucketLimit;
    uint64  public defaultDeployGasBucketDuration;
    
    struct DeployBucketConfig {
        uint256 gasBucketLimit;
        uint64 gasBucketDuration;
        bool useCustomConfig;
    }
    
    mapping(address => DeployBucketConfig) private _deployerConfigs;
    mapping(address => uint256) private _deployGasUsedInWindow;
    mapping(address => uint64)  private _deployWindowStartedAt;

    // ========= Version =========
    uint256 public version;

    // ========= Eventos =========
    event Executed(
        address indexed from,
        address indexed to,
        uint32 indexed space,
        uint256 nonce,
        bytes32 dataHash,
        address caller,
        uint256 value
    );
    event Canceled(address indexed from, uint32 indexed space, uint256 nonce);
    event ContractDeployed(address indexed signer, address deployed, bytes32 dataHash);
    event CallerAllowedSet(address indexed caller, bool allowed);
    event GasLimitSet(address indexed caller, uint256 limit);
    event GasOverheadSet(uint256 overhead);
    event Erc2771AppendSenderSet(bool enabled);
    event DefaultDeployGasBucketConfigSet(uint256 limit, uint64 durationSeconds);
    event DeployerBucketConfigSet(address indexed deployer, uint256 limit, uint64 durationSeconds, bool useCustom);
    event AllowedDeployerSet(address indexed account, bool allowed);
    event ContractUpgraded(address indexed newImplementation, uint256 newVersion);

    // ========= Errors =========
    error CallerNotAllowed();
    error UnexpectedCaller();
    error DeadlineExpired();
    error DataMismatch();
    error DigestUsed();
    error NonceUsed();
    error BadMsgValue();
    error CreateFailed();
    error CallFailed(bytes returnData);
    error BlockGasQuotaExceeded();
    error ZeroAddress();
    error InvalidSignature();
    error DeployGasExceeded();
    error DeployPerBlockExceeded();
    error DeployTimeWindowGasExceeded();
    error DeployerNotAllowed();

    // ========= Structs =========
    struct Forward {
        address from;
        address to;
        uint256 value;
        uint32  space;
        uint256 nonce;
        uint256 deadline;
        bytes32 dataHash;
        address caller;
    }

    struct DeployerInfo {
        address deployer;
        bool allowed;
        uint256 gasUsedInWindow;
        uint64 windowStartedAt;
        uint256 lastDeployBlock;
        uint256 gasBucketLimit;
        uint64 gasBucketDuration;
        bool useCustomConfig;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Inicializador que reemplaza al constructor
    /// @param initialOwner Dirección del propietario inicial
    function initialize(address initialOwner) public initializer {
        __EIP712_init("PermissionedMetaTxHub", "1");
        __Ownable_init(initialOwner);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        
        // Valores por defecto
        gasAccountingOverhead = 15_000;
        erc2771AppendSender = true;
        defaultDeployGasBucketLimit = 10_000_000;
        defaultDeployGasBucketDuration = 600;
        version = 1;
    }

    /// @notice Reinicializador para upgrades futuros (ejemplo v2)
    /// @dev Solo puede ser llamado durante un upgrade
    function initializeV2() public reinitializer(2) {
        version = 2;
        // Aquí puedes agregar nueva lógica de inicialización para v2
    }

    // ========= UUPS Upgrade Authorization =========
    /// @notice Autoriza el upgrade del contrato
    /// @dev Solo el owner puede autorizar upgrades
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        version++;
        emit ContractUpgraded(newImplementation, version);
    }

    /// @notice Retorna la versión actual del contrato
    function getVersion() external view returns (uint256) {
        return version;
    }

    // ========= Admin =========
    function setCallerAllowed(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        isCallerAllowed[caller] = allowed;
        
        if (allowed) {
            _allowedCallers.add(caller);
        } else {
            _allowedCallers.remove(caller);
        }
        
        emit CallerAllowedSet(caller, allowed);
    }

    function setGasLimitPerBlock(address caller, uint256 limit) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        gasLimitPerBlock[caller] = limit;
        emit GasLimitSet(caller, limit);
    }

    function setGasAccountingOverhead(uint256 overhead) external onlyOwner {
        gasAccountingOverhead = overhead;
        emit GasOverheadSet(overhead);
    }

    function setErc2771AppendSender(bool enabled) external onlyOwner {
        erc2771AppendSender = enabled;
        emit Erc2771AppendSenderSet(enabled);
    }

    function setDefaultDeployGasBucketConfig(uint256 limit, uint64 durationSeconds) external onlyOwner {
        defaultDeployGasBucketLimit    = limit;
        defaultDeployGasBucketDuration = durationSeconds;
        emit DefaultDeployGasBucketConfigSet(limit, durationSeconds);
    }

    function setDeployerBucketConfig(
        address deployer,
        uint256 limit,
        uint64 durationSeconds,
        bool useCustom
    ) external onlyOwner {
        if (deployer == address(0)) revert ZeroAddress();
        
        _deployerConfigs[deployer] = DeployBucketConfig({
            gasBucketLimit: limit,
            gasBucketDuration: durationSeconds,
            useCustomConfig: useCustom
        });
        
        emit DeployerBucketConfigSet(deployer, limit, durationSeconds, useCustom);
    }

    function setDeployersBucketConfig(
        address[] calldata deployers,
        uint256[] calldata limits,
        uint64[] calldata durations,
        bool[] calldata useCustoms
    ) external onlyOwner {
        uint256 len = deployers.length;
        require(len == limits.length && len == durations.length && len == useCustoms.length, "Length mismatch");
        
        for (uint256 i; i < len; ) {
            address deployer = deployers[i];
            if (deployer == address(0)) revert ZeroAddress();
            
            _deployerConfigs[deployer] = DeployBucketConfig({
                gasBucketLimit: limits[i],
                gasBucketDuration: durations[i],
                useCustomConfig: useCustoms[i]
            });
            
            emit DeployerBucketConfigSet(deployer, limits[i], durations[i], useCustoms[i]);
            unchecked { ++i; }
        }
    }

    function setAllowedDeployer(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        allowedDeployers[account] = allowed;
        
        if (allowed) {
            _allowedDeployersSet.add(account);
        } else {
            _allowedDeployersSet.remove(account);
        }
        
        emit AllowedDeployerSet(account, allowed);
    }

    function setAllowedDeployers(address[] calldata accounts, bool allowed) external onlyOwner {
        uint256 len = accounts.length;
        for (uint256 i; i < len; ) {
            address a = accounts[i];
            if (a == address(0)) revert ZeroAddress();
            allowedDeployers[a] = allowed;
            
            if (allowed) {
                _allowedDeployersSet.add(a);
            } else {
                _allowedDeployersSet.remove(a);
            }
            
            emit AllowedDeployerSet(a, allowed);
            unchecked { ++i; }
        }
    }

    // ========= Views =========
    function getAllowedDeployers() external view returns (address[] memory) {
        return _allowedDeployersSet.values();
    }

    function getAllowedDeployersCount() external view returns (uint256) {
        return _allowedDeployersSet.length();
    }

    function getAllowedDeployerAt(uint256 index) external view returns (address) {
        return _allowedDeployersSet.at(index);
    }

    function getDeployerBucketConfig(address deployer) 
        external 
        view 
        returns (uint256 limit, uint64 duration, bool useCustom) 
    {
        DeployBucketConfig memory config = _deployerConfigs[deployer];
        
        if (config.useCustomConfig) {
            return (config.gasBucketLimit, config.gasBucketDuration, true);
        } else {
            return (defaultDeployGasBucketLimit, defaultDeployGasBucketDuration, false);
        }
    }

    function getDeployerInfo(address deployer) external view returns (DeployerInfo memory) {
        DeployBucketConfig memory config = _deployerConfigs[deployer];
        uint256 limit;
        uint64 duration;
        
        if (config.useCustomConfig) {
            limit = config.gasBucketLimit;
            duration = config.gasBucketDuration;
        } else {
            limit = defaultDeployGasBucketLimit;
            duration = defaultDeployGasBucketDuration;
        }
        
        return DeployerInfo({
            deployer: deployer,
            allowed: allowedDeployers[deployer],
            gasUsedInWindow: _deployGasUsedInWindow[deployer],
            windowStartedAt: _deployWindowStartedAt[deployer],
            lastDeployBlock: _lastDeployBlockByFrom[deployer],
            gasBucketLimit: limit,
            gasBucketDuration: duration,
            useCustomConfig: config.useCustomConfig
        });
    }

    function getDeployersInfo(address[] calldata deployers) 
        external 
        view 
        returns (DeployerInfo[] memory) 
    {
        uint256 len = deployers.length;
        DeployerInfo[] memory infos = new DeployerInfo[](len);
        
        for (uint256 i; i < len; ) {
            address deployer = deployers[i];
            DeployBucketConfig memory config = _deployerConfigs[deployer];
            uint256 limit;
            uint64 duration;
            
            if (config.useCustomConfig) {
                limit = config.gasBucketLimit;
                duration = config.gasBucketDuration;
            } else {
                limit = defaultDeployGasBucketLimit;
                duration = defaultDeployGasBucketDuration;
            }
            
            infos[i] = DeployerInfo({
                deployer: deployer,
                allowed: allowedDeployers[deployer],
                gasUsedInWindow: _deployGasUsedInWindow[deployer],
                windowStartedAt: _deployWindowStartedAt[deployer],
                lastDeployBlock: _lastDeployBlockByFrom[deployer],
                gasBucketLimit: limit,
                gasBucketDuration: duration,
                useCustomConfig: config.useCustomConfig
            });
            unchecked { ++i; }
        }
        
        return infos;
    }

    function getAllowedCallers() external view returns (address[] memory) {
        return _allowedCallers.values();
    }

    function getAllowedCallersCount() external view returns (uint256) {
        return _allowedCallers.length();
    }

    function gasUsedThisBlock(address caller)
        external
        view
        returns (uint256 used, uint256 limit, uint256 blockNo)
    {
        used = _gasUsedThisBlock[caller];
        limit = gasLimitPerBlock[caller];
        blockNo = _lastBlockForCaller[caller];
    }

    function deployGasWindowState(address from)
        external
        view
        returns (uint256 used, uint256 limit, uint64 startedAt, uint64 duration, uint256 nowTs)
    {
        DeployBucketConfig memory config = _deployerConfigs[from];
        
        used      = _deployGasUsedInWindow[from];
        startedAt = _deployWindowStartedAt[from];
        nowTs     = block.timestamp;
        
        if (config.useCustomConfig) {
            limit = config.gasBucketLimit;
            duration = config.gasBucketDuration;
        } else {
            limit = defaultDeployGasBucketLimit;
            duration = defaultDeployGasBucketDuration;
        }
    }

    // ========= Ejecución =========
    function execute(
        Forward calldata f,
        bytes calldata data,
        bytes calldata signature
    ) external payable nonReentrant {
        uint256 gasStart = gasleft();
        if (!isCallerAllowed[msg.sender]) revert CallerNotAllowed();
        if (f.caller != msg.sender) revert UnexpectedCaller();
        if (block.timestamp > f.deadline) revert DeadlineExpired();
        if (keccak256(data) != f.dataHash) revert DataMismatch();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    FORWARD_TYPEHASH,
                    f.from, f.to, f.value, f.space, f.nonce, f.deadline, f.dataHash, f.caller
                )
            )
        );
        _validateSignature(f.from, digest, signature);

        if (usedDigest[digest]) revert DigestUsed();
        _consumeNonce(f.from, f.space, f.nonce);
        usedDigest[digest] = true;

        if (msg.value != f.value) revert BadMsgValue();

        if (f.to == address(0)) {
            _executeCreate(f, data);
        } else {
            _executeCall(f, data);
        }

        _enforceAndConsumeCallerGas(gasStart, msg.sender);
        emit Executed(f.from, f.to, f.space, f.nonce, f.dataHash, f.caller, f.value);
    }

    // ========= CREATE =========
    function _executeCreate(Forward calldata f, bytes calldata data) internal {
        if (!allowedDeployers[f.from]) revert DeployerNotAllowed();

        DeployBucketConfig memory config = _deployerConfigs[f.from];
        uint256 limit;
        uint64 dur;
        
        if (config.useCustomConfig) {
            limit = config.gasBucketLimit;
            dur = config.gasBucketDuration;
        } else {
            limit = defaultDeployGasBucketLimit;
            dur = defaultDeployGasBucketDuration;
        }

        uint64 started = _deployWindowStartedAt[f.from];
        if (started == 0 || (dur != 0 && uint64(block.timestamp) >= started + dur)) {
            _deployWindowStartedAt[f.from] = uint64(block.timestamp);
            _deployGasUsedInWindow[f.from] = 0;
        }

        if (_lastDeployBlockByFrom[f.from] == block.number) revert DeployPerBlockExceeded();

        uint256 gasBefore = gasleft();
        address deployed;
        bytes memory creation = data;

        assembly {
            deployed := create(callvalue(), add(creation, 0x20), mload(creation))
            if iszero(deployed) {
                let size := returndatasize()
                if gt(size, MAX_RETURN_DATA_SIZE) { size := MAX_RETURN_DATA_SIZE }
                let ptr := mload(0x40)
                returndatacopy(ptr, 0, size)
                revert(ptr, size)
            }
        }

        uint256 gasAfter = gasleft();
        unchecked {
            uint256 deploySpent = gasBefore - gasAfter;
            if (deploySpent > DEPLOY_GAS_LIMIT) revert DeployGasExceeded();
            
            if (limit != 0 && dur != 0) {
                uint256 newTotal = _deployGasUsedInWindow[f.from] + deploySpent;
                if (newTotal > limit) revert DeployTimeWindowGasExceeded();
                _deployGasUsedInWindow[f.from] = newTotal;
            }
        }

        _lastDeployBlockByFrom[f.from] = block.number;
        emit ContractDeployed(f.from, deployed, f.dataHash);
    }

    // ========= CALL =========
    function _executeCall(Forward calldata f, bytes calldata data) internal {
        address target = f.to;
        uint256 value = f.value;
        bytes memory payload = erc2771AppendSender ? abi.encodePacked(data, f.from) : data;
        bool success;
        bytes memory returnData;
        assembly {
            let ptr := add(payload, 0x20)
            let len := mload(payload)
            success := call(gas(), target, value, ptr, len, 0, 0)
            let size := returndatasize()
            if gt(size, MAX_RETURN_DATA_SIZE) { size := MAX_RETURN_DATA_SIZE }
            returnData := mload(0x40)
            mstore(returnData, size)
            returndatacopy(add(returnData, 0x20), 0, size)
            mstore(0x40, add(add(returnData, 0x20), size))
        }
        if (!success) revert CallFailed(returnData);
    }

    // ========= Helpers =========
    function _validateSignature(
        address signerOrWallet,
        bytes32 digest,
        bytes calldata signature
    ) internal view {
        if (signerOrWallet.code.length > 0) {
            bytes4 magicValue = IERC1271.isValidSignature.selector;
            try IERC1271(signerOrWallet).isValidSignature(digest, signature) returns (bytes4 result) {
                if (result != magicValue) revert InvalidSignature();
            } catch {
                revert InvalidSignature();
            }
        } else {
            if (ECDSA.recover(digest, signature) != signerOrWallet)
                revert InvalidSignature();
        }
    }

    function _consumeNonce(address user, uint32 space, uint256 nonce) internal {
        (uint256 word, uint256 mask) = _wordAndMask(nonce);
        uint256 bitmap = noncesUsed[user][space][word];
        if ((bitmap & mask) != 0) revert NonceUsed();
        noncesUsed[user][space][word] = bitmap | mask;
    }

    function _wordAndMask(uint256 nonce) internal pure returns (uint256 word, uint256 mask) {
        unchecked {
            word = nonce >> 8;
            uint256 bit = nonce & 0xff;
            mask = (uint256(1) << bit);
        }
    }

    function _enforceAndConsumeCallerGas(uint256 gasStart, address caller) internal {
        uint256 spent = gasStart - gasleft();
        unchecked { spent += gasAccountingOverhead; }
        if (_lastBlockForCaller[caller] != uint64(block.number)) {
            _lastBlockForCaller[caller] = uint64(block.number);
            _gasUsedThisBlock[caller] = 0;
        }
        uint256 newTotal = _gasUsedThisBlock[caller] + spent;
        uint256 limit = gasLimitPerBlock[caller];
        if (limit != 0 && newTotal > limit) revert BlockGasQuotaExceeded();
        _gasUsedThisBlock[caller] = newTotal;
    }

    receive() external payable {}
}
