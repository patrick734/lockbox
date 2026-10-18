// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Lockbox
/// @notice Token and LP-token locker for BOT Chain. Anyone can lock ERC-20 tokens
///         until a date, either all at once ("cliff") or released evenly over time
///         ("linear"). Locks are public and queryable by token, so holders can check
///         how much of a project's supply or liquidity is locked and for how long.
/// @dev    The contract owner can only set the flat BOT lock fee and pause new locks.
///         No function lets the owner move, shorten or unlock anyone's tokens.
///         Rebasing tokens are not supported (amounts are recorded at deposit).
contract Lockbox is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct Lock {
        address token;
        uint40 start;     // linear schedule anchor
        uint40 unlock;    // everything is withdrawable from this time
        bool linear;
        address owner;
        uint128 amount;   // total locked
        uint128 withdrawn;
        uint128 vestedBase; // linear only: amount already released at `start`
        string label;
    }

    uint256 public constant MAX_FEE = 1 ether; // fee can never exceed 1 BOT
    uint256 public constant MAX_LOCK_DURATION = 3650 days;

    uint256 public lockFee = 0.1 ether;
    address public treasury;
    uint256 public feesAccrued;

    uint256 public lockCount;
    mapping(uint256 => Lock) private _locks;
    mapping(address => uint256[]) private _byToken;
    mapping(address => uint256[]) private _byOwner;

    event Locked(uint256 indexed id, address indexed token, address indexed owner, uint256 amount, uint256 unlock, bool linear, string label);
    event Withdrawn(uint256 indexed id, address indexed owner, uint256 amount);
    event Extended(uint256 indexed id, uint256 newUnlock);
    event LockTransferred(uint256 indexed id, address indexed from, address indexed to);
    event FeesCollected(address indexed treasury, uint256 amount);
    event ConfigUpdated(uint256 lockFee, address treasury);

    error InvalidParams();
    error WrongFee();
    error NotLockOwner();
    error NothingUnlocked();
    error TransferFailed();

    constructor(address owner_, address treasury_) Ownable(owner_) {
        if (treasury_ == address(0)) revert InvalidParams();
        treasury = treasury_;
    }

    // ------------------------------------------------------------ locking

    /// @notice Lock `amount` of `token` until `unlockTime`. Send exactly `lockFee` in BOT.
    /// @param linear If true, tokens become withdrawable evenly from now until `unlockTime`.
    function lock(address token, uint256 amount, uint40 unlockTime, bool linear, string calldata label)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 id)
    {
        if (msg.value != lockFee) revert WrongFee();
        if (token == address(0) || amount == 0 || bytes(label).length > 120) revert InvalidParams();
        if (unlockTime <= block.timestamp || unlockTime > block.timestamp + MAX_LOCK_DURATION) revert InvalidParams();

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before; // records what actually arrived
        if (received == 0 || received > type(uint128).max) revert InvalidParams();

        id = ++lockCount;
        Lock storage l = _locks[id];
        l.token = token;
        l.owner = msg.sender;
        l.start = uint40(block.timestamp);
        l.unlock = unlockTime;
        l.linear = linear;
        l.amount = uint128(received);
        l.label = label;
        _byToken[token].push(id);
        _byOwner[msg.sender].push(id);
        feesAccrued += msg.value;

        emit Locked(id, token, msg.sender, received, unlockTime, linear, label);
    }

    /// @notice Withdraw everything that has unlocked so far.
    function withdraw(uint256 id) external nonReentrant {
        Lock storage l = _locks[id];
        if (msg.sender != l.owner) revert NotLockOwner();
        uint256 available = _vested(l) - l.withdrawn;
        if (available == 0) revert NothingUnlocked();
        l.withdrawn += uint128(available);
        IERC20(l.token).safeTransfer(msg.sender, available);
        emit Withdrawn(id, msg.sender, available);
    }

    /// @notice Push the unlock date later. It can never be moved earlier.
    ///         For linear locks, whatever has already unlocked stays unlocked and
    ///         the rest is spread evenly from now until the new date.
    function extend(uint256 id, uint40 newUnlock) external {
        Lock storage l = _locks[id];
        if (msg.sender != l.owner) revert NotLockOwner();
        if (newUnlock <= l.unlock || newUnlock > block.timestamp + MAX_LOCK_DURATION) revert InvalidParams();
        if (l.linear) {
            l.vestedBase = uint128(_vested(l));
            l.start = uint40(block.timestamp);
        }
        l.unlock = newUnlock;
        emit Extended(id, newUnlock);
    }

    /// @notice Hand the lock (and the right to withdraw it later) to another address.
    function transferLock(uint256 id, address to) external {
        Lock storage l = _locks[id];
        if (msg.sender != l.owner) revert NotLockOwner();
        if (to == address(0) || to == l.owner) revert InvalidParams();
        l.owner = to;
        _byOwner[to].push(id);
        emit LockTransferred(id, msg.sender, to);
    }

    // ------------------------------------------------------------ fees & admin

    /// @notice Sends accrued lock fees to the treasury. Anyone may call it.
    function collectFees() external nonReentrant {
        uint256 amount = feesAccrued;
        if (amount == 0) revert NothingUnlocked();
        feesAccrued = 0;
        (bool ok, ) = payable(treasury).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FeesCollected(treasury, amount);
    }

    function setConfig(uint256 lockFee_, address treasury_) external onlyOwner {
        if (lockFee_ > MAX_FEE || treasury_ == address(0)) revert InvalidParams();
        lockFee = lockFee_;
        treasury = treasury_;
        emit ConfigUpdated(lockFee_, treasury_);
    }

    /// @notice Pausing only blocks new locks. Withdraw, extend and transfer always work.
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ------------------------------------------------------------ views

    function getLock(uint256 id) external view returns (Lock memory) { return _locks[id]; }

    /// @notice Amount the lock owner could withdraw right now.
    function withdrawable(uint256 id) external view returns (uint256) {
        Lock storage l = _locks[id];
        if (l.owner == address(0)) return 0;
        return _vested(l) - l.withdrawn;
    }

    /// @notice Amount still locked (not yet unlocked) right now.
    function stillLocked(uint256 id) external view returns (uint256) {
        Lock storage l = _locks[id];
        if (l.owner == address(0)) return 0;
        return l.amount - _vested(l);
    }

    function locksOfToken(address token) external view returns (uint256[] memory) { return _byToken[token]; }

    /// @notice Lock ids ever held by `account`. Check getLock(id).owner: transferred locks stay listed.
    function locksOfOwner(address account) external view returns (uint256[] memory) { return _byOwner[account]; }

    // ------------------------------------------------------------ internals

    function _vested(Lock storage l) private view returns (uint256) {
        if (block.timestamp >= l.unlock) return l.amount;
        if (!l.linear) return 0;
        uint256 base = l.vestedBase;
        if (block.timestamp <= l.start) return base;
        return base + ((uint256(l.amount) - base) * (block.timestamp - l.start)) / (uint256(l.unlock) - l.start);
    }
}
