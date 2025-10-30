# 🎮 Rock Paper Scissors - Blockchain Game

A secure, decentralized Rock-Paper-Scissors game built on Ethereum with ERC-2771 meta-transaction support.

## 🌟 Features

- **Commit-Reveal Pattern**: Prevents front-running and ensures fair play
- **Meta-Transaction Support**: Gasless gameplay via ERC-2771
- **Wager System**: Players bet ETH on game outcomes
- **Timeout Protection**: Automatic resolution if players don't respond
- **Multiple Simultaneous Games**: Support for concurrent games
- **Secure Withdrawals**: ReentrancyGuard protection

## 🎯 How It Works

### Game Flow

```
┌──────────────────────────────────────────────────────────────┐
│                    GAME LIFECYCLE                             │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  1. Player 1: Create Game                                    │
│     └─> Submit hashed move + wager                           │
│                                                               │
│  2. Player 2: Join Game                                      │
│     └─> Submit plain move + matching wager                   │
│                                                               │
│  3. Player 1: Reveal Move                                    │
│     └─> Reveal original move + salt                          │
│                                                               │
│  4. Automatic Settlement                                     │
│     └─> Winner determined, funds distributed                 │
│                                                               │
│  5. Withdrawal                                               │
│     └─> Players withdraw their winnings                      │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your keys
```

### Testing

```bash
# Run all tests
npx hardhat test

# Run only RockPaperScissors tests
npx hardhat test test/RockPaperScissors.test.js

# Run with gas reporting
REPORT_GAS=true npx hardhat test
```

### Deployment

#### Simple Deployment (Local/Testing)

```bash
# Deploy to local network
npx hardhat run scripts/deployRockPaperScissorsSimple.js --network localhost

# Deploy to Polygon Amoy testnet
npx hardhat run scripts/deployRockPaperScissorsSimple.js --network amoy
```

#### Meta-Transaction Deployment (Production)

```bash
# Deploy via PermissionedMetaTxHub
npx hardhat run scripts/deployRockPaperScissors.js --network amoy
```

## 📖 Usage Guide

### 1. Creating a Game (Player 1)

```javascript
// Import contract
const RockPaperScissors = await ethers.getContractAt(
  "RockPaperScissors",
  CONTRACT_ADDRESS
);

// Define moves
const Move = {
  ROCK: 1,
  PAPER: 2,
  SCISSORS: 3
};

// Create hashed move
const myMove = Move.ROCK;
const mySalt = "mySecretSalt123"; // Keep this secret!
const hashedMove = await RockPaperScissors.hashMove(myMove, mySalt);

// Create game
const wager = ethers.parseEther("0.1");
const opponent = ethers.ZeroAddress; // Anyone can join, or specify address

const tx = await RockPaperScissors.connect(player1).createGame(
  hashedMove,
  opponent,
  { value: wager }
);

const receipt = await tx.wait();
console.log(`Game created! Game ID: 0`);
```

### 2. Joining a Game (Player 2)

```javascript
const gameId = 0;
const myMove = Move.PAPER;
const wager = ethers.parseEther("0.1");

const tx = await RockPaperScissors.connect(player2).joinGame(
  gameId,
  myMove,
  { value: wager }
);

await tx.wait();
console.log("Joined game successfully!");
```

### 3. Revealing Move (Player 1)

```javascript
const gameId = 0;
const myMove = Move.ROCK;
const mySalt = "mySecretSalt123"; // Same salt used during creation

const tx = await RockPaperScissors.connect(player1).revealMove(
  gameId,
  myMove,
  mySalt
);

await tx.wait();
console.log("Move revealed! Game settled automatically.");
```

### 4. Withdrawing Winnings

```javascript
// Check balance
const balance = await RockPaperScissors.balances(player.address);
console.log(`Your balance: ${ethers.formatEther(balance)} ETH`);

// Withdraw all
const tx = await RockPaperScissors.connect(player).withdrawAll();
await tx.wait();
console.log("Winnings withdrawn!");

// Or withdraw specific amount
const amount = ethers.parseEther("0.2");
await RockPaperScissors.connect(player).withdraw(amount);
```

## 🎲 Game Rules

### Winning Combinations

- **Rock** beats **Scissors** ✊ > ✌️
- **Paper** beats **Rock** ✋ > ✊
- **Scissors** beats **Paper** ✌️ > ✋

### Wager Distribution

| Outcome | Player 1 | Player 2 |
|---------|----------|----------|
| Player 1 Wins | 2x wager | 0 |
| Player 2 Wins | 0 | 2x wager |
| Tie | 1x wager | 1x wager |

## ⏱️ Timeouts

### Join Timeout (1 hour)

If no one joins within 1 hour, Player 1 can cancel and get refund:

```javascript
await RockPaperScissors.connect(player1).cancelGame(gameId);
```

### Reveal Timeout (5 minutes)

If Player 1 doesn't reveal within 5 minutes after Player 2 joins, Player 2 can claim victory:

```javascript
await RockPaperScissors.connect(player2).claimTimeout(gameId);
```

## 🔐 Security Features

### Commit-Reveal Pattern

Prevents front-running by using a two-phase commitment:

1. **Commit Phase**: Player 1 submits `keccak256(abi.encodePacked(move, salt))`
2. **Reveal Phase**: Player 1 reveals `move` and `salt`, contract verifies hash

### Hash Generation

```javascript
// Off-chain (JavaScript)
const hash = ethers.solidityPackedKeccak256(
  ["uint8", "string"],
  [move, salt]
);

// On-chain (Solidity)
bytes32 hash = keccak256(abi.encodePacked(uint8(move), salt));
```

### Protection Mechanisms

- **ReentrancyGuard**: Prevents reentrancy attacks on withdrawals
- **Access Control**: Only authorized players can perform actions
- **Input Validation**: All inputs are validated before execution
- **Deadline Enforcement**: Time-based restrictions prevent indefinite locks

## 📊 Contract Interface

### Main Functions

```solidity
// Create a new game
function createGame(bytes32 hashedMove, address opponent)
    external payable returns (uint256 gameId)

// Join an existing game
function joinGame(uint256 gameId, Move move)
    external payable

// Reveal Player 1's move
function revealMove(uint256 gameId, Move move, string calldata salt)
    external

// Claim timeout victory
function claimTimeout(uint256 gameId)
    external

// Cancel game after join timeout
function cancelGame(uint256 gameId)
    external

// Withdraw winnings
function withdraw(uint256 amount)
    external

function withdrawAll()
    external
```

### View Functions

```solidity
// Get game details
function getGame(uint256 gameId)
    external view returns (Game memory)

// Get player balance
function getBalance(address player)
    external view returns (uint256)

// Hash a move
function hashMove(Move move, string calldata salt)
    external pure returns (bytes32)

// Get total games created
function getGameCounter()
    external view returns (uint256)
```

## 🎭 Game States

```solidity
enum GameStatus {
    WAITING_FOR_PLAYER2,  // Player 1 created, waiting for Player 2
    WAITING_FOR_REVEAL,   // Player 2 joined, waiting for Player 1 to reveal
    REVEALED,             // Player 1 revealed, ready to settle
    SETTLED,              // Game completed and settled
    CANCELLED             // Game cancelled (timeout or invalid)
}
```

## 📝 Events

```solidity
event GameCreated(
    uint256 indexed gameId,
    address indexed player1,
    address indexed opponent,
    uint256 wager
);

event GameJoined(
    uint256 indexed gameId,
    address indexed player2,
    Move move2
);

event GameRevealed(
    uint256 indexed gameId,
    address indexed player1,
    Move move1,
    Move move2
);

event GameSettled(
    uint256 indexed gameId,
    address indexed winner,
    uint256 prize,
    bool isTie
);

event GameCancelled(
    uint256 indexed gameId,
    string reason
);

event BalanceWithdrawn(
    address indexed player,
    uint256 amount
);
```

## 🧪 Testing Examples

### Example Test Cases

```javascript
describe("RockPaperScissors", function () {
  it("Should create and settle a game", async function () {
    // Player 1 creates game with ROCK
    const hashedMove = hashMove(Move.ROCK, "secret");
    await rps.connect(player1).createGame(hashedMove, ethers.ZeroAddress, {
      value: wager
    });

    // Player 2 joins with SCISSORS
    await rps.connect(player2).joinGame(0, Move.SCISSORS, {
      value: wager
    });

    // Player 1 reveals
    await rps.connect(player1).revealMove(0, Move.ROCK, "secret");

    // Check winner
    const game = await rps.games(0);
    expect(game.winner).to.equal(player1.address);
    expect(await rps.balances(player1.address)).to.equal(wager * 2n);
  });
});
```

## 🛠️ Advanced Features

### Meta-Transaction Support

The contract supports ERC-2771 meta-transactions, enabling gasless gameplay:

```javascript
// Users can play without ETH for gas
// Relayer pays gas fees
// Contract uses _msgSender() instead of msg.sender
```

### Multiple Games

Players can participate in multiple games simultaneously:

```javascript
// Create multiple games
await rps.createGame(hash1, opponent1, { value: wager });
await rps.createGame(hash2, opponent2, { value: wager });

// Track games by ID
const game0 = await rps.getGame(0);
const game1 = await rps.getGame(1);
```

## 🔍 Verification

After deployment, verify the contract on block explorer:

```bash
npx hardhat verify --network amoy <CONTRACT_ADDRESS> <TRUSTED_FORWARDER>
```

## 📚 Additional Resources

- [EIP-2771: Secure Protocol for Native Meta Transactions](https://eips.ethereum.org/EIPS/eip-2771)
- [Commit-Reveal Schemes](https://karl.tech/learning-solidity-part-2-voting/)
- [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts/)

## 🤝 Contributing

Contributions are welcome! Please ensure:

1. All tests pass: `npx hardhat test`
2. Code follows existing style
3. New features include tests
4. Documentation is updated

## 📄 License

MIT License - See LICENSE file for details

## ⚠️ Disclaimer

This is experimental software. Use at your own risk. Always audit smart contracts before using them in production.

---

**Happy Gaming! 🎮🎲**
