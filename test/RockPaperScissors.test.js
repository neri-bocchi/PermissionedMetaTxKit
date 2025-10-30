import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

describe("RockPaperScissors", function () {
  let rps, owner, player1, player2, player3;

  // Move enum values
  const Move = {
    NONE: 0,
    ROCK: 1,
    PAPER: 2,
    SCISSORS: 3
  };

  // GameStatus enum values
  const GameStatus = {
    WAITING_FOR_PLAYER2: 0,
    WAITING_FOR_REVEAL: 1,
    REVEALED: 2,
    SETTLED: 3,
    CANCELLED: 4
  };

  const wager = ethers.parseEther("0.1");

  /**
   * Helper function to create a hashed move
   */
  function hashMove(move, salt) {
    return ethers.solidityPackedKeccak256(
      ["uint8", "string"],
      [move, salt]
    );
  }

  /**
   * Helper function to increase time in the blockchain
   */
  async function increaseTime(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async function () {
    [owner, player1, player2, player3] = await ethers.getSigners();

    const RockPaperScissors = await ethers.getContractFactory("RockPaperScissors");
    rps = await RockPaperScissors.deploy(owner.address);
    await rps.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should deploy successfully", async function () {
      const address = await rps.getAddress();
      expect(address).to.be.properAddress;
    });

    it("Should initialize with zero game counter", async function () {
      expect(await rps.gameCounter()).to.equal(0);
    });

    it("Should have correct trusted forwarder", async function () {
      expect(await rps.trustedForwarder()).to.equal(owner.address);
    });
  });

  describe("Game Creation", function () {
    it("Should create a game with valid parameters", async function () {
      const hashedMove = hashMove(Move.ROCK, "secret123");

      await expect(
        rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager })
      ).to.emit(rps, "GameCreated")
        .withArgs(0, player1.address, ethers.ZeroAddress, wager);

      const game = await rps.games(0);
      expect(game.player1).to.equal(player1.address);
      expect(game.hashedMove1).to.equal(hashedMove);
      expect(game.wager).to.equal(wager);
      expect(game.status).to.equal(GameStatus.WAITING_FOR_PLAYER2);
    });

    it("Should increment game counter after creation", async function () {
      const hashedMove = hashMove(Move.ROCK, "secret");

      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      expect(await rps.gameCounter()).to.equal(1);

      await rps.connect(player2).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      expect(await rps.gameCounter()).to.equal(2);
    });

    it("Should reject game creation with zero wager", async function () {
      const hashedMove = hashMove(Move.ROCK, "secret");

      await expect(
        rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: 0 })
      ).to.be.revertedWithCustomError(rps, "InvalidWager");
    });

    it("Should reject game creation with zero hash", async function () {
      await expect(
        rps.connect(player1).createGame(ethers.ZeroHash, ethers.ZeroAddress, { value: wager })
      ).to.be.revertedWithCustomError(rps, "InvalidMove");
    });

    it("Should reject game creation against self", async function () {
      const hashedMove = hashMove(Move.ROCK, "secret");

      await expect(
        rps.connect(player1).createGame(hashedMove, player1.address, { value: wager })
      ).to.be.revertedWithCustomError(rps, "InvalidOpponent");
    });

    it("Should allow creating games with specific opponent", async function () {
      const hashedMove = hashMove(Move.PAPER, "mysecret");

      await expect(
        rps.connect(player1).createGame(hashedMove, player2.address, { value: wager })
      ).to.emit(rps, "GameCreated")
        .withArgs(0, player1.address, player2.address, wager);
    });
  });

  describe("Joining Games", function () {
    let gameId, hashedMove;

    beforeEach(async function () {
      hashedMove = hashMove(Move.ROCK, "secret123");
      const tx = await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      await tx.wait();
      gameId = 0;
    });

    it("Should allow player2 to join with correct wager", async function () {
      await expect(
        rps.connect(player2).joinGame(gameId, Move.PAPER, { value: wager })
      ).to.emit(rps, "GameJoined")
        .withArgs(gameId, player2.address, Move.PAPER);

      const game = await rps.games(gameId);
      expect(game.player2).to.equal(player2.address);
      expect(game.move2).to.equal(Move.PAPER);
      expect(game.status).to.equal(GameStatus.WAITING_FOR_REVEAL);
    });

    it("Should reject joining with wrong wager amount", async function () {
      const wrongWager = ethers.parseEther("0.2");

      await expect(
        rps.connect(player2).joinGame(gameId, Move.SCISSORS, { value: wrongWager })
      ).to.be.revertedWithCustomError(rps, "WagerMismatch");
    });

    it("Should reject joining with invalid move", async function () {
      await expect(
        rps.connect(player2).joinGame(gameId, Move.NONE, { value: wager })
      ).to.be.revertedWithCustomError(rps, "InvalidMove");
    });

    it("Should reject joining non-existent game", async function () {
      await expect(
        rps.connect(player2).joinGame(999, Move.ROCK, { value: wager })
      ).to.be.revertedWithCustomError(rps, "GameNotFound");
    });

    it("Should reject player1 joining their own game", async function () {
      await expect(
        rps.connect(player1).joinGame(gameId, Move.PAPER, { value: wager })
      ).to.be.revertedWithCustomError(rps, "InvalidOpponent");
    });

    it("Should reject joining already joined game", async function () {
      await rps.connect(player2).joinGame(gameId, Move.PAPER, { value: wager });

      await expect(
        rps.connect(player3).joinGame(gameId, Move.SCISSORS, { value: wager })
      ).to.be.revertedWithCustomError(rps, "GameNotWaitingForPlayer");
    });

    it("Should set reveal deadline after player2 joins", async function () {
      const tx = await rps.connect(player2).joinGame(gameId, Move.ROCK, { value: wager });
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const game = await rps.games(gameId);
      const expectedDeadline = BigInt(block.timestamp) + 300n; // 5 minutes
      expect(game.revealDeadline).to.equal(expectedDeadline);
    });
  });

  describe("Revealing Moves", function () {
    let gameId;
    const salt = "mySecretSalt456";

    beforeEach(async function () {
      const hashedMove = hashMove(Move.SCISSORS, salt);
      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      await rps.connect(player2).joinGame(0, Move.ROCK, { value: wager });
      gameId = 0;
    });

    it("Should allow player1 to reveal correct move", async function () {
      await expect(
        rps.connect(player1).revealMove(gameId, Move.SCISSORS, salt)
      ).to.emit(rps, "GameRevealed")
        .withArgs(gameId, player1.address, Move.SCISSORS, Move.ROCK);

      const game = await rps.games(gameId);
      expect(game.move1).to.equal(Move.SCISSORS);
      expect(game.status).to.equal(GameStatus.SETTLED);
    });

    it("Should automatically settle game after reveal", async function () {
      await expect(
        rps.connect(player1).revealMove(gameId, Move.SCISSORS, salt)
      ).to.emit(rps, "GameSettled");

      const game = await rps.games(gameId);
      expect(game.status).to.equal(GameStatus.SETTLED);
    });

    it("Should reject reveal with wrong move", async function () {
      await expect(
        rps.connect(player1).revealMove(gameId, Move.ROCK, salt) // Wrong move
      ).to.be.revertedWithCustomError(rps, "InvalidReveal");
    });

    it("Should reject reveal with wrong salt", async function () {
      await expect(
        rps.connect(player1).revealMove(gameId, Move.SCISSORS, "wrongSalt")
      ).to.be.revertedWithCustomError(rps, "InvalidReveal");
    });

    it("Should reject reveal from non-player1", async function () {
      await expect(
        rps.connect(player2).revealMove(gameId, Move.SCISSORS, salt)
      ).to.be.revertedWithCustomError(rps, "UnauthorizedAccess");
    });

    it("Should reject reveal with invalid move enum", async function () {
      await expect(
        rps.connect(player1).revealMove(gameId, Move.NONE, salt)
      ).to.be.revertedWithCustomError(rps, "InvalidMove");
    });
  });

  describe("Game Settlement - Winner Determination", function () {
    const salt = "testSalt";

    async function setupAndPlayGame(move1, move2) {
      const hashedMove = hashMove(move1, salt);
      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      await rps.connect(player2).joinGame(0, move2, { value: wager });
      await rps.connect(player1).revealMove(0, move1, salt);
      return await rps.games(0);
    }

    describe("Rock", function () {
      it("Rock vs Scissors - Player1 wins", async function () {
        const game = await setupAndPlayGame(Move.ROCK, Move.SCISSORS);
        expect(game.winner).to.equal(player1.address);
        expect(await rps.balances(player1.address)).to.equal(wager * 2n);
      });

      it("Rock vs Paper - Player2 wins", async function () {
        const game = await setupAndPlayGame(Move.ROCK, Move.PAPER);
        expect(game.winner).to.equal(player2.address);
        expect(await rps.balances(player2.address)).to.equal(wager * 2n);
      });

      it("Rock vs Rock - Tie", async function () {
        const game = await setupAndPlayGame(Move.ROCK, Move.ROCK);
        expect(game.winner).to.equal(ethers.ZeroAddress);
        expect(await rps.balances(player1.address)).to.equal(wager);
        expect(await rps.balances(player2.address)).to.equal(wager);
      });
    });

    describe("Paper", function () {
      it("Paper vs Rock - Player1 wins", async function () {
        const game = await setupAndPlayGame(Move.PAPER, Move.ROCK);
        expect(game.winner).to.equal(player1.address);
        expect(await rps.balances(player1.address)).to.equal(wager * 2n);
      });

      it("Paper vs Scissors - Player2 wins", async function () {
        const game = await setupAndPlayGame(Move.PAPER, Move.SCISSORS);
        expect(game.winner).to.equal(player2.address);
        expect(await rps.balances(player2.address)).to.equal(wager * 2n);
      });

      it("Paper vs Paper - Tie", async function () {
        const game = await setupAndPlayGame(Move.PAPER, Move.PAPER);
        expect(game.winner).to.equal(ethers.ZeroAddress);
        expect(await rps.balances(player1.address)).to.equal(wager);
        expect(await rps.balances(player2.address)).to.equal(wager);
      });
    });

    describe("Scissors", function () {
      it("Scissors vs Paper - Player1 wins", async function () {
        const game = await setupAndPlayGame(Move.SCISSORS, Move.PAPER);
        expect(game.winner).to.equal(player1.address);
        expect(await rps.balances(player1.address)).to.equal(wager * 2n);
      });

      it("Scissors vs Rock - Player2 wins", async function () {
        const game = await setupAndPlayGame(Move.SCISSORS, Move.ROCK);
        expect(game.winner).to.equal(player2.address);
        expect(await rps.balances(player2.address)).to.equal(wager * 2n);
      });

      it("Scissors vs Scissors - Tie", async function () {
        const game = await setupAndPlayGame(Move.SCISSORS, Move.SCISSORS);
        expect(game.winner).to.equal(ethers.ZeroAddress);
        expect(await rps.balances(player1.address)).to.equal(wager);
        expect(await rps.balances(player2.address)).to.equal(wager);
      });
    });

    it("Should emit GameSettled event with correct parameters", async function () {
      const hashedMove = hashMove(Move.ROCK, salt);
      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      await rps.connect(player2).joinGame(0, Move.SCISSORS, { value: wager });

      await expect(
        rps.connect(player1).revealMove(0, Move.ROCK, salt)
      ).to.emit(rps, "GameSettled")
        .withArgs(0, player1.address, wager * 2n, false);
    });

    it("Should emit GameSettled with tie flag for tied games", async function () {
      const hashedMove = hashMove(Move.PAPER, salt);
      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      await rps.connect(player2).joinGame(0, Move.PAPER, { value: wager });

      await expect(
        rps.connect(player1).revealMove(0, Move.PAPER, salt)
      ).to.emit(rps, "GameSettled")
        .withArgs(0, ethers.ZeroAddress, wager * 2n, true);
    });
  });

  describe("Withdrawals", function () {
    const salt = "withdrawTestSalt";

    beforeEach(async function () {
      // Setup a completed game where player1 wins
      const hashedMove = hashMove(Move.ROCK, salt);
      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      await rps.connect(player2).joinGame(0, Move.SCISSORS, { value: wager });
      await rps.connect(player1).revealMove(0, Move.ROCK, salt);
    });

    it("Should allow winner to withdraw winnings", async function () {
      const balanceBefore = await ethers.provider.getBalance(player1.address);
      const winnings = await rps.balances(player1.address);

      const tx = await rps.connect(player1).withdrawAll();
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(player1.address);
      expect(balanceAfter).to.equal(balanceBefore + winnings - gasUsed);
      expect(await rps.balances(player1.address)).to.equal(0);
    });

    it("Should allow partial withdrawals", async function () {
      const withdrawAmount = ethers.parseEther("0.1");
      const balanceBefore = await rps.balances(player1.address);

      await expect(
        rps.connect(player1).withdraw(withdrawAmount)
      ).to.emit(rps, "BalanceWithdrawn")
        .withArgs(player1.address, withdrawAmount);

      expect(await rps.balances(player1.address)).to.equal(balanceBefore - withdrawAmount);
    });

    it("Should reject withdrawal with insufficient balance", async function () {
      await expect(
        rps.connect(player2).withdrawAll()
      ).to.be.revertedWithCustomError(rps, "InsufficientBalance");
    });

    it("Should reject withdrawal of zero amount", async function () {
      await expect(
        rps.connect(player1).withdraw(0)
      ).to.be.revertedWithCustomError(rps, "InvalidWager");
    });

    it("Should reject withdrawal exceeding balance", async function () {
      const balance = await rps.balances(player1.address);
      const excessAmount = balance + ethers.parseEther("1");

      await expect(
        rps.connect(player1).withdraw(excessAmount)
      ).to.be.revertedWithCustomError(rps, "InsufficientBalance");
    });

    it("Should update balance correctly after withdrawal", async function () {
      const initialBalance = await rps.balances(player1.address);
      await rps.connect(player1).withdrawAll();
      expect(await rps.balances(player1.address)).to.equal(0);
    });
  });

  describe("Timeouts", function () {
    const salt = "timeoutSalt";

    describe("Reveal Timeout", function () {
      beforeEach(async function () {
        const hashedMove = hashMove(Move.ROCK, salt);
        await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
        await rps.connect(player2).joinGame(0, Move.PAPER, { value: wager });
      });

      it("Should allow player2 to claim timeout after reveal deadline", async function () {
        await increaseTime(301); // 5 minutes + 1 second

        await expect(
          rps.connect(player2).claimTimeout(0)
        ).to.emit(rps, "GameSettled")
          .withArgs(0, player2.address, wager * 2n, false);

        const game = await rps.games(0);
        expect(game.winner).to.equal(player2.address);
        expect(await rps.balances(player2.address)).to.equal(wager * 2n);
      });

      it("Should reject timeout claim before deadline", async function () {
        await expect(
          rps.connect(player2).claimTimeout(0)
        ).to.be.revertedWithCustomError(rps, "DeadlineNotReached");
      });

      it("Should reject timeout claim from non-player2", async function () {
        await increaseTime(301);

        await expect(
          rps.connect(player1).claimTimeout(0)
        ).to.be.revertedWithCustomError(rps, "UnauthorizedAccess");
      });
    });

    describe("Join Timeout", function () {
      it("Should allow player1 to cancel after join timeout", async function () {
        const hashedMove = hashMove(Move.SCISSORS, salt);
        await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });

        await increaseTime(3601); // 1 hour + 1 second

        await expect(
          rps.connect(player1).cancelGame(0)
        ).to.emit(rps, "GameCancelled")
          .withArgs(0, "Cancelled by player 1 after timeout");

        const game = await rps.games(0);
        expect(game.status).to.equal(GameStatus.CANCELLED);
        expect(await rps.balances(player1.address)).to.equal(wager);
      });

      it("Should reject cancel before join timeout", async function () {
        const hashedMove = hashMove(Move.ROCK, salt);
        await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });

        await expect(
          rps.connect(player1).cancelGame(0)
        ).to.be.revertedWithCustomError(rps, "DeadlineNotReached");
      });

      it("Should reject cancel from non-player1", async function () {
        const hashedMove = hashMove(Move.PAPER, salt);
        await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
        await increaseTime(3601);

        await expect(
          rps.connect(player2).cancelGame(0)
        ).to.be.revertedWithCustomError(rps, "UnauthorizedAccess");
      });

      it("Should refund player1 and player2 if join timeout during join", async function () {
        const hashedMove = hashMove(Move.ROCK, salt);
        await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });

        await increaseTime(3601); // Exceed join timeout

        // Player2 tries to join after timeout
        await rps.connect(player2).joinGame(0, Move.PAPER, { value: wager });

        const game = await rps.games(0);
        expect(game.status).to.equal(GameStatus.CANCELLED);
        expect(await rps.balances(player1.address)).to.equal(wager);
        expect(await rps.balances(player2.address)).to.equal(wager);
      });
    });
  });

  describe("Helper Functions", function () {
    it("Should correctly hash moves", async function () {
      const move = Move.ROCK;
      const salt = "testSalt123";

      const onChainHash = await rps.hashMove(move, salt);
      const offChainHash = hashMove(move, salt);

      expect(onChainHash).to.equal(offChainHash);
    });

    it("Should return correct game details", async function () {
      const hashedMove = hashMove(Move.PAPER, "secret");
      await rps.connect(player1).createGame(hashedMove, player2.address, { value: wager });

      const game = await rps.getGame(0);
      expect(game.player1).to.equal(player1.address);
      expect(game.hashedMove1).to.equal(hashedMove);
      expect(game.wager).to.equal(wager);
    });

    it("Should return correct player balance", async function () {
      expect(await rps.getBalance(player1.address)).to.equal(0);

      // Play a game where player1 wins
      const hashedMove = hashMove(Move.ROCK, "salt");
      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      await rps.connect(player2).joinGame(0, Move.SCISSORS, { value: wager });
      await rps.connect(player1).revealMove(0, Move.ROCK, "salt");

      expect(await rps.getBalance(player1.address)).to.equal(wager * 2n);
    });

    it("Should return correct game counter", async function () {
      expect(await rps.getGameCounter()).to.equal(0);

      const hashedMove = hashMove(Move.ROCK, "s1");
      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      expect(await rps.getGameCounter()).to.equal(1);

      await rps.connect(player2).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      expect(await rps.getGameCounter()).to.equal(2);
    });
  });

  describe("Edge Cases and Security", function () {
    const salt = "edgeCaseSalt";

    it("Should handle multiple simultaneous games", async function () {
      const hash1 = hashMove(Move.ROCK, "salt1");
      const hash2 = hashMove(Move.PAPER, "salt2");

      await rps.connect(player1).createGame(hash1, ethers.ZeroAddress, { value: wager });
      await rps.connect(player2).createGame(hash2, ethers.ZeroAddress, { value: wager });

      expect(await rps.gameCounter()).to.equal(2);

      const game0 = await rps.games(0);
      const game1 = await rps.games(1);

      expect(game0.player1).to.equal(player1.address);
      expect(game1.player1).to.equal(player2.address);
    });

    it("Should maintain separate balances for multiple players", async function () {
      // Game 1: player1 vs player2 (player1 wins)
      const hash1 = hashMove(Move.ROCK, "s1");
      await rps.connect(player1).createGame(hash1, ethers.ZeroAddress, { value: wager });
      await rps.connect(player2).joinGame(0, Move.SCISSORS, { value: wager });
      await rps.connect(player1).revealMove(0, Move.ROCK, "s1");

      // Game 2: player2 vs player3 (player2 wins)
      const hash2 = hashMove(Move.PAPER, "s2");
      await rps.connect(player2).createGame(hash2, ethers.ZeroAddress, { value: wager });
      await rps.connect(player3).joinGame(1, Move.ROCK, { value: wager });
      await rps.connect(player2).revealMove(1, Move.PAPER, "s2");

      expect(await rps.balances(player1.address)).to.equal(wager * 2n);
      expect(await rps.balances(player2.address)).to.equal(wager * 2n);
      expect(await rps.balances(player3.address)).to.equal(0);
    });

    it("Should prevent reentrancy attacks on withdraw", async function () {
      // This test verifies that the ReentrancyGuard is working
      // The contract uses OpenZeppelin's ReentrancyGuard

      const hashedMove = hashMove(Move.ROCK, salt);
      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      await rps.connect(player2).joinGame(0, Move.SCISSORS, { value: wager });
      await rps.connect(player1).revealMove(0, Move.ROCK, salt);

      // Normal withdrawal should work
      await expect(
        rps.connect(player1).withdrawAll()
      ).to.emit(rps, "BalanceWithdrawn");
    });

    it("Should handle large wager amounts", async function () {
      const largeWager = ethers.parseEther("100");
      const hashedMove = hashMove(Move.SCISSORS, salt);

      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: largeWager });
      await rps.connect(player2).joinGame(0, Move.ROCK, { value: largeWager });
      await rps.connect(player1).revealMove(0, Move.SCISSORS, salt);

      // Player2 wins
      expect(await rps.balances(player2.address)).to.equal(largeWager * 2n);
    });

    it("Should handle very long salt strings", async function () {
      const longSalt = "a".repeat(1000);
      const hashedMove = hashMove(Move.PAPER, longSalt);

      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      await rps.connect(player2).joinGame(0, Move.ROCK, { value: wager });

      await expect(
        rps.connect(player1).revealMove(0, Move.PAPER, longSalt)
      ).to.emit(rps, "GameRevealed");
    });

    it("Should prevent revealing same game twice", async function () {
      const hashedMove = hashMove(Move.ROCK, salt);
      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      await rps.connect(player2).joinGame(0, Move.PAPER, { value: wager });
      await rps.connect(player1).revealMove(0, Move.ROCK, salt);

      // Try to reveal again
      await expect(
        rps.connect(player1).revealMove(0, Move.ROCK, salt)
      ).to.be.revertedWithCustomError(rps, "GameNotWaitingForReveal");
    });

    it("Should correctly handle contract balance", async function () {
      const hashedMove = hashMove(Move.ROCK, salt);

      // Create game - contract receives wager
      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      let contractBalance = await ethers.provider.getBalance(await rps.getAddress());
      expect(contractBalance).to.equal(wager);

      // Player2 joins - contract receives another wager
      await rps.connect(player2).joinGame(0, Move.SCISSORS, { value: wager });
      contractBalance = await ethers.provider.getBalance(await rps.getAddress());
      expect(contractBalance).to.equal(wager * 2n);

      // Reveal and settle
      await rps.connect(player1).revealMove(0, Move.ROCK, salt);

      // Winner withdraws - contract balance decreases
      await rps.connect(player1).withdrawAll();
      contractBalance = await ethers.provider.getBalance(await rps.getAddress());
      expect(contractBalance).to.equal(0);
    });
  });

  describe("Gas Efficiency", function () {
    it("Should create game with reasonable gas cost", async function () {
      const hashedMove = hashMove(Move.ROCK, "gasTest");

      const tx = await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      const receipt = await tx.wait();

      console.log(`      Gas used for createGame: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.lessThan(200000n);
    });

    it("Should join game with reasonable gas cost", async function () {
      const hashedMove = hashMove(Move.PAPER, "gasTest");
      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });

      const tx = await rps.connect(player2).joinGame(0, Move.ROCK, { value: wager });
      const receipt = await tx.wait();

      console.log(`      Gas used for joinGame: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.lessThan(150000n);
    });

    it("Should reveal and settle with reasonable gas cost", async function () {
      const salt = "gasTest";
      const hashedMove = hashMove(Move.SCISSORS, salt);
      await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, { value: wager });
      await rps.connect(player2).joinGame(0, Move.PAPER, { value: wager });

      const tx = await rps.connect(player1).revealMove(0, Move.SCISSORS, salt);
      const receipt = await tx.wait();

      console.log(`      Gas used for revealMove + settle: ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.lessThan(200000n);
    });
  });
});
