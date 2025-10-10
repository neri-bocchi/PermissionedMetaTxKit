import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

describe("Storage", function () {
  let storage;
  let owner;
  let user1;
  let user2;

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    const Storage = await ethers.getContractFactory("Storage");
    storage = await Storage.deploy();
    await storage.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      expect(await storage.owner()).to.equal(owner.address);
    });

    it("Should initialize with zero", async function () {
      expect(await storage.retrieve()).to.equal(0);
    });
  });

  describe("Store Function", function () {
    it("Should store a number", async function () {
      await storage.store(42);
      expect(await storage.retrieve()).to.equal(42);
    });

    it("Should emit NumberStored event", async function () {
      await expect(storage.store(42))
        .to.emit(storage, "NumberStored")
        .withArgs(42, owner.address);
    });

    it("Should allow anyone to store", async function () {
      await storage.connect(user1).store(100);
      expect(await storage.retrieve()).to.equal(100);
    });

    it("Should overwrite previous value", async function () {
      await storage.store(42);
      await storage.store(99);
      expect(await storage.retrieve()).to.equal(99);
    });

    it("Should handle zero value", async function () {
      await storage.store(42);
      await storage.store(0);
      expect(await storage.retrieve()).to.equal(0);
    });

    it("Should handle large numbers", async function () {
      const largeNumber = ethers.parseEther("1000000");
      await storage.store(largeNumber);
      expect(await storage.retrieve()).to.equal(largeNumber);
    });
  });

  describe("Retrieve Function", function () {
    it("Should retrieve stored value", async function () {
      await storage.store(42);
      expect(await storage.retrieve()).to.equal(42);
    });

    it("Should be a view function (no state change)", async function () {
      await storage.store(42);
      const value1 = await storage.retrieve();
      const value2 = await storage.retrieve();
      expect(value1).to.equal(value2);
    });
  });

  describe("Increment Function", function () {
    it("Should increment by 1", async function () {
      await storage.store(10);
      await storage.increment();
      expect(await storage.retrieve()).to.equal(11);
    });

    it("Should emit NumberStored event", async function () {
      await storage.store(10);
      await expect(storage.increment())
        .to.emit(storage, "NumberStored")
        .withArgs(11, owner.address);
    });

    it("Should only allow owner to increment", async function () {
      await storage.store(10);
      await expect(storage.connect(user1).increment())
        .to.be.revertedWith("Only owner can call this function");
    });

    it("Should work multiple times", async function () {
      await storage.store(0);
      await storage.increment();
      await storage.increment();
      await storage.increment();
      expect(await storage.retrieve()).to.equal(3);
    });

    it("Should increment from zero", async function () {
      await storage.increment();
      expect(await storage.retrieve()).to.equal(1);
    });
  });

  describe("Reset Function", function () {
    it("Should reset to zero", async function () {
      await storage.store(42);
      await storage.reset();
      expect(await storage.retrieve()).to.equal(0);
    });

    it("Should emit NumberStored event", async function () {
      await storage.store(42);
      await expect(storage.reset())
        .to.emit(storage, "NumberStored")
        .withArgs(0, owner.address);
    });

    it("Should only allow owner to reset", async function () {
      await storage.store(42);
      await expect(storage.connect(user1).reset())
        .to.be.revertedWith("Only owner can call this function");
    });

    it("Should work when already zero", async function () {
      await storage.reset();
      expect(await storage.retrieve()).to.equal(0);
    });
  });

  describe("Owner Modifier", function () {
    it("Owner should be able to increment", async function () {
      await storage.store(5);
      await expect(storage.increment()).to.not.be.reverted;
    });

    it("Owner should be able to reset", async function () {
      await storage.store(5);
      await expect(storage.reset()).to.not.be.reverted;
    });

    it("Non-owner should not be able to increment", async function () {
      await expect(storage.connect(user1).increment())
        .to.be.revertedWith("Only owner can call this function");
    });

    it("Non-owner should not be able to reset", async function () {
      await expect(storage.connect(user1).reset())
        .to.be.revertedWith("Only owner can call this function");
    });
  });

  describe("Event Tracking", function () {
    it("Should emit correct address for different callers", async function () {
      await expect(storage.connect(user1).store(10))
        .to.emit(storage, "NumberStored")
        .withArgs(10, user1.address);

      await expect(storage.connect(user2).store(20))
        .to.emit(storage, "NumberStored")
        .withArgs(20, user2.address);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle max uint256", async function () {
      const maxUint256 = ethers.MaxUint256;
      await storage.store(maxUint256);
      expect(await storage.retrieve()).to.equal(maxUint256);
    });

    it("Should not overflow on increment at max value", async function () {
      const maxUint256 = ethers.MaxUint256;
      await storage.store(maxUint256);
      
      // This will revert due to Solidity 0.8+ overflow protection
      await expect(storage.increment()).to.be.reverted;
    });
  });

  describe("Gas Efficiency", function () {
    it("Should track gas usage for store", async function () {
      const tx = await storage.store(42);
      const receipt = await tx.wait();
      expect(receipt.gasUsed).to.be.lt(100000); // Should be efficient
    });

    it("Should track gas usage for retrieve", async function () {
      await storage.store(42);
      const gasEstimate = await storage.retrieve.estimateGas();
      expect(gasEstimate).to.be.lt(50000); // View functions are cheap
    });
  });
});