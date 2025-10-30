// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RockPaperScissors
 * @dev A blockchain-based Rock-Paper-Scissors game with commit-reveal pattern
 * @notice This contract supports ERC-2771 meta-transactions for gasless gameplay
 *
 * Game Flow:
 * 1. Player 1 creates a game with a hashed move and wager
 * 2. Player 2 joins the game by matching the wager and submitting their move
 * 3. Player 1 reveals their move with the secret salt
 * 4. Game is settled automatically, determining the winner
 * 5. Winner can withdraw their prize
 */
contract RockPaperScissors is ERC2771Context, ReentrancyGuard {

    // Move options
    enum Move { NONE, ROCK, PAPER, SCISSORS }

    // Game status
    enum GameStatus {
        WAITING_FOR_PLAYER2,    // Player 1 created, waiting for Player 2
        WAITING_FOR_REVEAL,      // Player 2 joined, waiting for Player 1 to reveal
        REVEALED,                // Player 1 revealed, ready to settle
        SETTLED,                 // Game completed and settled
        CANCELLED                // Game cancelled (timeout or invalid)
    }

    // Game structure
    struct Game {
        address player1;
        address player2;
        bytes32 hashedMove1;     // Hashed move of player 1 (commit)
        Move move1;              // Revealed move of player 1
        Move move2;              // Move of player 2
        uint256 wager;           // Wager amount in wei
        uint256 createdAt;       // Timestamp when game was created
        uint256 joinedAt;        // Timestamp when player 2 joined
        uint256 revealDeadline;  // Deadline for player 1 to reveal (after player 2 joins)
        GameStatus status;
        address winner;          // Winner address (or address(0) for tie)
    }

    // State variables
    mapping(uint256 => Game) public games;
    mapping(address => uint256) public balances;  // Withdrawable balances
    uint256 public gameCounter;

    // Constants
    uint256 public constant REVEAL_TIMEOUT = 5 minutes;  // Time limit for reveal
    uint256 public constant JOIN_TIMEOUT = 1 hours;      // Time limit to join game

    // Events
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

    // Errors
    error InvalidMove();
    error InvalidWager();
    error GameNotFound();
    error UnauthorizedAccess();
    error GameAlreadyJoined();
    error GameNotWaitingForPlayer();
    error GameNotWaitingForReveal();
    error InvalidReveal();
    error WagerMismatch();
    error DeadlineNotReached();
    error InsufficientBalance();
    error TransferFailed();
    error InvalidOpponent();

    /**
     * @dev Constructor
     * @param trustedForwarder Address of the trusted forwarder for meta-transactions
     */
    constructor(address trustedForwarder) ERC2771Context(trustedForwarder) {}

    /**
     * @dev Creates a new game with a hashed move (commit phase)
     * @param hashedMove Keccak256 hash of abi.encodePacked(move, salt)
     * @param opponent Address of the opponent (address(0) for anyone)
     * @return gameId The ID of the created game
     *
     * Example hash: keccak256(abi.encodePacked(uint8(Move.ROCK), "mySecretSalt123"))
     */
    function createGame(
        bytes32 hashedMove,
        address opponent
    ) external payable returns (uint256 gameId) {
        if (hashedMove == bytes32(0)) revert InvalidMove();
        if (msg.value == 0) revert InvalidWager();
        if (opponent == _msgSender()) revert InvalidOpponent();

        gameId = gameCounter++;

        games[gameId] = Game({
            player1: _msgSender(),
            player2: address(0),
            hashedMove1: hashedMove,
            move1: Move.NONE,
            move2: Move.NONE,
            wager: msg.value,
            createdAt: block.timestamp,
            joinedAt: 0,
            revealDeadline: 0,
            status: GameStatus.WAITING_FOR_PLAYER2,
            winner: address(0)
        });

        emit GameCreated(gameId, _msgSender(), opponent, msg.value);
    }

    /**
     * @dev Joins an existing game by submitting a move
     * @param gameId The ID of the game to join
     * @param move The move choice (ROCK, PAPER, or SCISSORS)
     */
    function joinGame(uint256 gameId, Move move) external payable {
        Game storage game = games[gameId];

        if (game.player1 == address(0)) revert GameNotFound();
        if (game.status != GameStatus.WAITING_FOR_PLAYER2) revert GameNotWaitingForPlayer();
        if (move == Move.NONE || move > Move.SCISSORS) revert InvalidMove();
        if (msg.value != game.wager) revert WagerMismatch();
        if (_msgSender() == game.player1) revert InvalidOpponent();

        // Check if join timeout has passed
        if (block.timestamp > game.createdAt + JOIN_TIMEOUT) {
            // Cancel game and refund player 1
            game.status = GameStatus.CANCELLED;
            balances[game.player1] += game.wager;
            balances[_msgSender()] += msg.value;
            emit GameCancelled(gameId, "Join timeout exceeded");
            return;
        }

        game.player2 = _msgSender();
        game.move2 = move;
        game.joinedAt = block.timestamp;
        game.revealDeadline = block.timestamp + REVEAL_TIMEOUT;
        game.status = GameStatus.WAITING_FOR_REVEAL;

        emit GameJoined(gameId, _msgSender(), move);
    }

    /**
     * @dev Reveals player 1's move and settles the game
     * @param gameId The ID of the game
     * @param move The actual move made by player 1
     * @param salt The secret salt used in the hash
     */
    function revealMove(uint256 gameId, Move move, string calldata salt) external {
        Game storage game = games[gameId];

        if (game.player1 == address(0)) revert GameNotFound();
        if (_msgSender() != game.player1) revert UnauthorizedAccess();
        if (game.status != GameStatus.WAITING_FOR_REVEAL) revert GameNotWaitingForReveal();
        if (move == Move.NONE || move > Move.SCISSORS) revert InvalidMove();

        // Verify the reveal matches the commitment
        bytes32 computedHash = keccak256(abi.encodePacked(uint8(move), salt));
        if (computedHash != game.hashedMove1) revert InvalidReveal();

        game.move1 = move;
        game.status = GameStatus.REVEALED;

        emit GameRevealed(gameId, game.player1, move, game.move2);

        // Settle the game immediately after reveal
        _settleGame(gameId);
    }

    /**
     * @dev Claims victory if opponent fails to reveal within the deadline
     * @param gameId The ID of the game
     */
    function claimTimeout(uint256 gameId) external {
        Game storage game = games[gameId];

        if (game.player1 == address(0)) revert GameNotFound();
        if (_msgSender() != game.player2) revert UnauthorizedAccess();
        if (game.status != GameStatus.WAITING_FOR_REVEAL) revert GameNotWaitingForReveal();
        if (block.timestamp <= game.revealDeadline) revert DeadlineNotReached();

        // Player 2 wins by timeout
        game.status = GameStatus.SETTLED;
        game.winner = game.player2;

        uint256 prize = game.wager * 2;
        balances[game.player2] += prize;

        emit GameCancelled(gameId, "Reveal timeout - Player 2 wins");
        emit GameSettled(gameId, game.player2, prize, false);
    }

    /**
     * @dev Internal function to settle the game based on moves
     * @param gameId The ID of the game to settle
     */
    function _settleGame(uint256 gameId) internal {
        Game storage game = games[gameId];

        if (game.status != GameStatus.REVEALED) return;

        game.status = GameStatus.SETTLED;

        // Determine winner
        address winner = _determineWinner(game.move1, game.move2, game.player1, game.player2);
        game.winner = winner;

        uint256 prize = game.wager * 2;
        bool isTie = (winner == address(0));

        if (isTie) {
            // Tie - refund both players
            balances[game.player1] += game.wager;
            balances[game.player2] += game.wager;
        } else {
            // Winner takes all
            balances[winner] += prize;
        }

        emit GameSettled(gameId, winner, prize, isTie);
    }

    /**
     * @dev Determines the winner based on moves
     * @param move1 Player 1's move
     * @param move2 Player 2's move
     * @param player1 Player 1's address
     * @param player2 Player 2's address
     * @return winner The winner's address (or address(0) for tie)
     */
    function _determineWinner(
        Move move1,
        Move move2,
        address player1,
        address player2
    ) internal pure returns (address winner) {
        if (move1 == move2) {
            return address(0); // Tie
        }

        // Rock beats Scissors
        if (move1 == Move.ROCK && move2 == Move.SCISSORS) return player1;
        if (move2 == Move.ROCK && move1 == Move.SCISSORS) return player2;

        // Paper beats Rock
        if (move1 == Move.PAPER && move2 == Move.ROCK) return player1;
        if (move2 == Move.PAPER && move1 == Move.ROCK) return player2;

        // Scissors beats Paper
        if (move1 == Move.SCISSORS && move2 == Move.PAPER) return player1;
        if (move2 == Move.SCISSORS && move1 == Move.PAPER) return player2;

        return address(0); // Should never reach here
    }

    /**
     * @dev Withdraws accumulated balance
     * @param amount Amount to withdraw in wei
     */
    function withdraw(uint256 amount) external nonReentrant {
        address sender = _msgSender();

        if (amount == 0) revert InvalidWager();
        if (balances[sender] < amount) revert InsufficientBalance();

        balances[sender] -= amount;

        (bool success, ) = payable(sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit BalanceWithdrawn(sender, amount);
    }

    /**
     * @dev Withdraws entire balance
     */
    function withdrawAll() external nonReentrant {
        address sender = _msgSender();
        uint256 amount = balances[sender];

        if (amount == 0) revert InsufficientBalance();

        balances[sender] = 0;

        (bool success, ) = payable(sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit BalanceWithdrawn(sender, amount);
    }

    /**
     * @dev Cancels a game if no one joined within timeout period
     * @param gameId The ID of the game to cancel
     */
    function cancelGame(uint256 gameId) external {
        Game storage game = games[gameId];

        if (game.player1 == address(0)) revert GameNotFound();
        if (_msgSender() != game.player1) revert UnauthorizedAccess();
        if (game.status != GameStatus.WAITING_FOR_PLAYER2) revert GameNotWaitingForPlayer();
        if (block.timestamp <= game.createdAt + JOIN_TIMEOUT) revert DeadlineNotReached();

        game.status = GameStatus.CANCELLED;
        balances[game.player1] += game.wager;

        emit GameCancelled(gameId, "Cancelled by player 1 after timeout");
    }

    /**
     * @dev Helper function to create a hash for committing a move
     * @param move The move to hash
     * @param salt The secret salt
     * @return The hash of the move and salt
     */
    function hashMove(Move move, string calldata salt) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(uint8(move), salt));
    }

    /**
     * @dev Gets game details
     * @param gameId The ID of the game
     * @return The game details
     */
    function getGame(uint256 gameId) external view returns (Game memory) {
        return games[gameId];
    }

    /**
     * @dev Gets player's withdrawable balance
     * @param player The player's address
     * @return The balance in wei
     */
    function getBalance(address player) external view returns (uint256) {
        return balances[player];
    }

    /**
     * @dev Gets the current game counter
     * @return The number of games created
     */
    function getGameCounter() external view returns (uint256) {
        return gameCounter;
    }
}
