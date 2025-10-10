import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

describe("PermissionedMetaTxHub", function () {
  let hub;
  let storage;
  let owner;
  let relayer;
  let user;
  let unauthorized;

  // EIP-712 setup
  const EIP712_DOMAIN = (hubAddress, chainId) => ({
    name: "PermissionedMetaTxHub",
    version: "1",
    chainId,
    verifyingContract: hubAddress,
  });

  const FORWARD_TYPES = {
    Forward: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "space", type: "uint32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "dataHash", type: "bytes32" },
      { name: "caller", type: "address" },
    ],
  };

  const CANCEL_TYPES = {
    Cancel: [
      { name: "from", type: "address" },
      { name: "space", type: "uint32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  beforeEach(async function () {
    [owner, relayer, user, unauthorized] = await ethers.getSigners();

    // Deploy hub
    const Hub = await ethers.getContractFactory("PermissionedMetaTxHub");
    hub = await Hub.deploy();
    await hub.waitForDeployment();

    // Deploy storage
    const Storage = await ethers.getContractFactory("Storage");
    storage = await Storage.deploy();
    await storage.waitForDeployment();

    // Authorize relayer
    await hub.setCallerAllowed(relayer.address, true);
  });

  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      expect(await hub.owner()).to.equal(owner.address);
    });

    it("Should have correct EIP-712 domain", async function () {
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);
      expect(domain.name).to.equal("PermissionedMetaTxHub");
      expect(domain.version).to.equal("1");
    });
  });

  describe("Caller Authorization", function () {
    it("Should allow owner to authorize caller", async function () {
      await expect(hub.setCallerAllowed(user.address, true))
        .to.emit(hub, "CallerAllowedSet")
        .withArgs(user.address, true);

      expect(await hub.isCallerAllowed(user.address)).to.be.true;
    });

    it("Should allow owner to unauthorize caller", async function () {
      await hub.setCallerAllowed(relayer.address, false);
      expect(await hub.isCallerAllowed(relayer.address)).to.be.false;
    });

    it("Should reject non-owner trying to authorize", async function () {
      await expect(
        hub.connect(user).setCallerAllowed(user.address, true)
      ).to.be.revertedWithCustomError(hub, "OwnableUnauthorizedAccount");
    });
  });

  describe("Meta-Transaction Execution", function () {
    it("Should execute meta-tx successfully", async function () {
      const iface = new ethers.Interface(["function store(uint256)"]);
      const callData = iface.encodeFunctionData("store", [42]);
      const dataHash = ethers.keccak256(callData);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const forward = {
        from: user.address,
        to: await storage.getAddress(),
        value: 0n,
        space: 0,
        nonce: 1,
        deadline,
        dataHash,
        caller: relayer.address,
      };

      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);
      const signature = await user.signTypedData(domain, FORWARD_TYPES, forward);

      await expect(
        hub.connect(relayer).execute(forward, callData, signature)
      )
        .to.emit(hub, "Executed")
        .withArgs(user.address, await storage.getAddress(), 0, 1, dataHash);

      expect(await storage.retrieve()).to.equal(42);
    });

    it("Should reject unauthorized caller", async function () {
      const iface = new ethers.Interface(["function store(uint256)"]);
      const callData = iface.encodeFunctionData("store", [42]);
      const dataHash = ethers.keccak256(callData);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const forward = {
        from: user.address,
        to: await storage.getAddress(),
        value: 0n,
        space: 0,
        nonce: 2,
        deadline,
        dataHash,
        caller: unauthorized.address,
      };

      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);
      const signature = await user.signTypedData(domain, FORWARD_TYPES, forward);

      await expect(
        hub.connect(unauthorized).execute(forward, callData, signature)
      ).to.be.revertedWith("caller not allowed");
    });

    it("Should reject expired deadline", async function () {
      const iface = new ethers.Interface(["function store(uint256)"]);
      const callData = iface.encodeFunctionData("store", [42]);
      const dataHash = ethers.keccak256(callData);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = Math.floor(Date.now() / 1000) - 3600; // Expired

      const forward = {
        from: user.address,
        to: await storage.getAddress(),
        value: 0n,
        space: 0,
        nonce: 3,
        deadline,
        dataHash,
        caller: relayer.address,
      };

      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);
      const signature = await user.signTypedData(domain, FORWARD_TYPES, forward);

      await expect(
        hub.connect(relayer).execute(forward, callData, signature)
      ).to.be.revertedWith("expired");
    });

    it("Should reject wrong signature", async function () {
      const iface = new ethers.Interface(["function store(uint256)"]);
      const callData = iface.encodeFunctionData("store", [42]);
      const dataHash = ethers.keccak256(callData);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const forward = {
        from: user.address,
        to: await storage.getAddress(),
        value: 0n,
        space: 0,
        nonce: 4,
        deadline,
        dataHash,
        caller: relayer.address,
      };

      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);
      // Wrong signer!
      const signature = await relayer.signTypedData(domain, FORWARD_TYPES, forward);

      await expect(
        hub.connect(relayer).execute(forward, callData, signature)
      ).to.be.revertedWith("bad sig");
    });

    it("Should reject data mismatch", async function () {
      const iface = new ethers.Interface(["function store(uint256)"]);
      const callData = iface.encodeFunctionData("store", [42]);
      const wrongCallData = iface.encodeFunctionData("store", [99]);
      const dataHash = ethers.keccak256(callData);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const forward = {
        from: user.address,
        to: await storage.getAddress(),
        value: 0n,
        space: 0,
        nonce: 5,
        deadline,
        dataHash,
        caller: relayer.address,
      };

      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);
      const signature = await user.signTypedData(domain, FORWARD_TYPES, forward);

      await expect(
        hub.connect(relayer).execute(forward, wrongCallData, signature)
      ).to.be.revertedWith("data mismatch");
    });

    it("Should reject replay attack (same nonce)", async function () {
      const iface = new ethers.Interface(["function store(uint256)"]);
      const callData = iface.encodeFunctionData("store", [42]);
      const dataHash = ethers.keccak256(callData);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const forward = {
        from: user.address,
        to: await storage.getAddress(),
        value: 0n,
        space: 0,
        nonce: 6,
        deadline,
        dataHash,
        caller: relayer.address,
      };

      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);
      const signature = await user.signTypedData(domain, FORWARD_TYPES, forward);

      // First execution
      await hub.connect(relayer).execute(forward, callData, signature);

      // Try to replay - should fail with "digest used" (el contrato verifica digest primero)
      await expect(
        hub.connect(relayer).execute(forward, callData, signature)
      ).to.be.revertedWith("digest used");
    });

    it("Should allow out-of-order nonces", async function () {
      const iface = new ethers.Interface(["function store(uint256)"]);
      
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);

      // Execute nonce 10
      const callData1 = iface.encodeFunctionData("store", [10]);
      const forward1 = {
        from: user.address,
        to: await storage.getAddress(),
        value: 0n,
        space: 0,
        nonce: 10,
        deadline,
        dataHash: ethers.keccak256(callData1),
        caller: relayer.address,
      };
      const sig1 = await user.signTypedData(domain, FORWARD_TYPES, forward1);
      await hub.connect(relayer).execute(forward1, callData1, sig1);

      // Execute nonce 5 (out of order, should work)
      const callData2 = iface.encodeFunctionData("store", [5]);
      const forward2 = {
        from: user.address,
        to: await storage.getAddress(),
        value: 0n,
        space: 0,
        nonce: 5,
        deadline,
        dataHash: ethers.keccak256(callData2),
        caller: relayer.address,
      };
      const sig2 = await user.signTypedData(domain, FORWARD_TYPES, forward2);
      await hub.connect(relayer).execute(forward2, callData2, sig2);

      expect(await storage.retrieve()).to.equal(5);
    });
  });

  describe("Contract Deployment via Meta-Tx", function () {
    it("Should deploy contract via CREATE", async function () {
      const StorageFactory = await ethers.getContractFactory("Storage");
      const deployBytecode = StorageFactory.bytecode;
      const dataHash = ethers.keccak256(deployBytecode);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const forward = {
        from: user.address,
        to: ethers.ZeroAddress, // CREATE
        value: 0n,
        space: 0,
        nonce: 100,
        deadline,
        dataHash,
        caller: relayer.address,
      };

      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);
      const signature = await user.signTypedData(domain, FORWARD_TYPES, forward);

      const tx = await hub.connect(relayer).execute(forward, deployBytecode, signature);
      const receipt = await tx.wait();

      // Find ContractDeployed event
      const event = receipt.logs
        .map((log) => {
          try {
            return hub.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "ContractDeployed");

      expect(event).to.not.be.undefined;
      expect(event.args.signer).to.equal(user.address);

      // Verify deployed contract works
      const deployedStorage = await ethers.getContractAt("Storage", event.args.deployed);
      // El owner será el hub porque msg.sender en el constructor es el hub
      expect(await deployedStorage.owner()).to.equal(await hub.getAddress());
    });
  });

  describe("Nonce Cancellation", function () {
    it("Should cancel nonce with signature", async function () {
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const space = 0;
      const nonce = 200;

      const cancel = {
        from: user.address,
        space,
        nonce,
        deadline,
      };

      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);
      const signature = await user.signTypedData(domain, CANCEL_TYPES, cancel);

      await expect(
        hub.connect(relayer).cancelWithSig(user.address, space, nonce, deadline, signature)
      )
        .to.emit(hub, "Canceled")
        .withArgs(user.address, space, nonce);

      expect(await hub.isNonceUsed(user.address, space, nonce)).to.be.true;
    });

    it("Should reject using cancelled nonce", async function () {
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const space = 0;
      const nonce = 201;

      // Cancel nonce first
      const cancel = { from: user.address, space, nonce, deadline };
      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);
      const cancelSig = await user.signTypedData(domain, CANCEL_TYPES, cancel);
      await hub.connect(relayer).cancelWithSig(user.address, space, nonce, deadline, cancelSig);

      // Try to use cancelled nonce
      const iface = new ethers.Interface(["function store(uint256)"]);
      const callData = iface.encodeFunctionData("store", [42]);
      const forward = {
        from: user.address,
        to: await storage.getAddress(),
        value: 0n,
        space,
        nonce,
        deadline,
        dataHash: ethers.keccak256(callData),
        caller: relayer.address,
      };
      const signature = await user.signTypedData(domain, FORWARD_TYPES, forward);

      await expect(
        hub.connect(relayer).execute(forward, callData, signature)
      ).to.be.revertedWith("nonce used");
    });
  });

  describe("Gas Quota Management", function () {
    it("Should set gas limit per block", async function () {
      const gasLimit = 1_000_000;

      await expect(hub.setGasLimitPerBlock(relayer.address, gasLimit))
        .to.emit(hub, "GasLimitSet")
        .withArgs(relayer.address, gasLimit);

      expect(await hub.gasLimitPerBlock(relayer.address)).to.equal(gasLimit);
    });

    it("Should track gas usage per block", async function () {
      const iface = new ethers.Interface(["function store(uint256)"]);
      const callData = iface.encodeFunctionData("store", [42]);
      const dataHash = ethers.keccak256(callData);

      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const forward = {
        from: user.address,
        to: await storage.getAddress(),
        value: 0n,
        space: 0,
        nonce: 300,
        deadline,
        dataHash,
        caller: relayer.address,
      };

      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);
      const signature = await user.signTypedData(domain, FORWARD_TYPES, forward);

      await hub.connect(relayer).execute(forward, callData, signature);

      const [used, limit, blockNo] = await hub.gasUsedThisBlock(relayer.address);
      expect(used).to.be.gt(0);
      expect(blockNo).to.equal(await ethers.provider.getBlockNumber());
    });
  });

  describe("Multiple Spaces", function () {
    it("Should allow same nonce in different spaces", async function () {
      const iface = new ethers.Interface(["function store(uint256)"]);
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const domain = EIP712_DOMAIN(await hub.getAddress(), chainId);
      const nonce = 999;

      // Space 0
      const callData1 = iface.encodeFunctionData("store", [10]);
      const forward1 = {
        from: user.address,
        to: await storage.getAddress(),
        value: 0n,
        space: 0,
        nonce,
        deadline,
        dataHash: ethers.keccak256(callData1),
        caller: relayer.address,
      };
      const sig1 = await user.signTypedData(domain, FORWARD_TYPES, forward1);
      await hub.connect(relayer).execute(forward1, callData1, sig1);

      // Space 1 (same nonce, different space)
      const callData2 = iface.encodeFunctionData("store", [20]);
      const forward2 = {
        from: user.address,
        to: await storage.getAddress(),
        value: 0n,
        space: 1,
        nonce,
        deadline,
        dataHash: ethers.keccak256(callData2),
        caller: relayer.address,
      };
      const sig2 = await user.signTypedData(domain, FORWARD_TYPES, forward2);
      await hub.connect(relayer).execute(forward2, callData2, sig2);

      expect(await storage.retrieve()).to.equal(20);
    });
  });
});