// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4337} from "solady/accounts/ERC4337.sol";
import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";

/// @title AgentVault
/// @notice ERC-4337 smart wallet with passkey authentication and agent session keys
/// @dev Enables yield optimization agents to propose transactions while users approve via Face ID/fingerprint
/// @author jinbang/agentic-wallet
contract AgentVault is ERC4337, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ProtocolNotWhitelisted();
    error SessionKeyExpired();
    error SessionKeySpendLimitExceeded();
    error DailyLimitExceeded();
    error SessionKeyDailyCapExceeded();
    error InvalidSignatureType();
    error AmountExceedsAutoExecuteThreshold();
    error NotWhitelistedOperation();
    error InvalidPublicKey();
    error AmountOverflow();
    error DirectExecuteDisabled();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Initialized(uint256 indexed ownerX, uint256 indexed ownerY);
    event ProtocolWhitelisted(address indexed protocol, bool status);
    event SessionKeyGranted(address indexed key, uint48 validUntil, uint128 spendLimit);
    event SessionKeyRevoked(address indexed key);
    event StrategyExecuted(address indexed protocol, bytes4 indexed selector, uint256 amount);
    event AutoExecuteThresholdUpdated(uint128 oldThreshold, uint128 newThreshold);
    event DailyLimitUpdated(uint128 oldLimit, uint128 newLimit);
    event SessionKeyDailyCapUpdated(uint128 oldCap, uint128 newCap);

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Passkey owner P-256 public key X coordinate
    uint256 public ownerX;

    /// @notice Passkey owner P-256 public key Y coordinate
    uint256 public ownerY;

    /// @notice Whitelisted yield protocols that the agent can interact with
    mapping(address => bool) public whitelistedProtocols;

    /// @notice Session key configuration for agents
    struct SessionKey {
        uint48 validUntil;
        uint128 spendLimit;
        uint128 spent;
    }
    mapping(address => SessionKey) public sessionKeys;

    /// @notice Daily spending limit (in USDC, 6 decimals)
    uint128 public dailyLimit;

    /// @notice Amount spent today
    uint128 public dailySpent;

    /// @notice Last day the daily limit was reset (unix day)
    uint64 public lastResetDay;

    /// @notice Minimum amount (in USDC, 6 decimals) that requires passkey approval
    /// @dev Default 0 means ALL transactions require passkey. Users can raise this to enable auto-execute.
    uint128 public autoExecuteThreshold;

    /// @notice Cumulative daily cap for ALL session key spending (C2 fix)
    /// @dev Prevents attack where multiple session keys drain funds
    uint128 public sessionKeyDailyCap;

    /// @notice Cumulative amount spent by ALL session keys today
    uint128 public sessionKeyDailySpent;

    /// @notice Last day the session key daily cap was reset
    uint64 public sessionKeyLastResetDay;

    /// @notice Signature type identifier for passkey signatures
    uint8 private constant SIG_TYPE_PASSKEY = 0;

    /// @notice Signature type identifier for session key signatures
    uint8 private constant SIG_TYPE_SESSION_KEY = 1;

    /// @notice secp256k1 curve order / 2 for signature malleability check
    uint256 private constant SECP256K1_N_DIV_2 = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @notice Transient storage slot for current session key (used to track spending)
    /// @dev Using EIP-1153 transient storage to pass session key from validation to execution
    /// @dev keccak256("AgentVault.currentSessionKey") = 0x...
    /// We use a fixed slot to avoid inline assembly limitations with constants
    uint256 private constant CURRENT_SESSION_KEY_SLOT =
        0x8c6f89522a4e1e5c5f5e8e8d6a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b;

    /*//////////////////////////////////////////////////////////////
                     PROTOCOL FUNCTION SELECTORS (C3 fix)
    //////////////////////////////////////////////////////////////*/

    /// @notice Aave V3 supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)
    bytes4 private constant AAVE_SUPPLY_SELECTOR = 0x617ba037;

    /// @notice Aave V3 withdraw(address asset, uint256 amount, address to)
    bytes4 private constant AAVE_WITHDRAW_SELECTOR = 0x69328dec;

    /// @notice Compound V3 supply(address asset, uint256 amount)
    bytes4 private constant COMPOUND_SUPPLY_SELECTOR = 0xf2b9fdb8;

    /// @notice Compound V3 withdraw(address asset, uint256 amount)
    bytes4 private constant COMPOUND_WITHDRAW_SELECTOR = 0xf3fef3a3;

    /// @notice Morpho Blue supply(MarketParams, uint256 assets, uint256 shares, address onBehalf, bytes data)
    bytes4 private constant MORPHO_SUPPLY_SELECTOR = 0x0c0a769b;

    /// @notice Morpho Blue withdraw(MarketParams, uint256 assets, uint256 shares, address onBehalf, address receiver)
    bytes4 private constant MORPHO_WITHDRAW_SELECTOR = 0x5c2bea49;

    /// @notice Moonwell / ERC4626 deposit(uint256 assets, address receiver)
    bytes4 private constant ERC4626_DEPOSIT_SELECTOR = 0x6e553f65;

    /// @notice Moonwell / ERC4626 withdraw(uint256 assets, address receiver, address owner)
    bytes4 private constant ERC4626_WITHDRAW_SELECTOR = 0xb460af94;

    /// @notice Moonwell mint(uint256 mintAmount) - cToken style
    bytes4 private constant CTOKEN_MINT_SELECTOR = 0xa0712d68;

    /// @notice Moonwell redeem(uint256 redeemTokens) - cToken style
    bytes4 private constant CTOKEN_REDEEM_SELECTOR = 0xdb006a75;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor() payable ERC4337() {}

    /*//////////////////////////////////////////////////////////////
                              INITIALIZER
    //////////////////////////////////////////////////////////////*/

    /// @notice Initialize the vault with passkey owner and configuration
    /// @param _ownerX P-256 public key X coordinate
    /// @param _ownerY P-256 public key Y coordinate
    /// @param _protocols Initial whitelisted protocol addresses
    /// @param _dailyLimit Maximum daily spend (6 decimals, e.g., 10000e6 = $10,000)
    /// @param _autoExecuteThreshold Amount below which session keys can auto-execute (default 0)
    /// @param _sessionKeyDailyCap Cumulative daily cap for all session key spending (C2 fix)
    function initialize(
        uint256 _ownerX,
        uint256 _ownerY,
        address[] calldata _protocols,
        uint128 _dailyLimit,
        uint128 _autoExecuteThreshold,
        uint128 _sessionKeyDailyCap
    ) external {
        if (ownerX != 0 || ownerY != 0) revert Unauthorized();
        if (_ownerX == 0 || _ownerY == 0) revert InvalidPublicKey();

        ownerX = _ownerX;
        ownerY = _ownerY;
        dailyLimit = _dailyLimit;
        autoExecuteThreshold = _autoExecuteThreshold;
        sessionKeyDailyCap = _sessionKeyDailyCap;

        for (uint256 i = 0; i < _protocols.length; i++) {
            whitelistedProtocols[_protocols[i]] = true;
            emit ProtocolWhitelisted(_protocols[i], true);
        }

        emit Initialized(_ownerX, _ownerY);
    }

    /*//////////////////////////////////////////////////////////////
                         SIGNATURE VALIDATION
    //////////////////////////////////////////////////////////////*/

    /// @dev Override Solady's signature validation to use WebAuthn
    /// @notice Not view because session key validation uses transient storage
    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        override
        returns (uint256 validationData)
    {
        if (userOp.signature.length == 0) return 1;

        uint8 sigType = uint8(userOp.signature[0]);

        if (sigType == SIG_TYPE_PASSKEY) {
            return _validatePasskeySignature(userOp.signature[1:], userOpHash);
        } else if (sigType == SIG_TYPE_SESSION_KEY) {
            return _validateSessionKeySignature(userOp, userOpHash);
        }

        return 1; // Invalid signature type
    }

    /// @dev Validate a passkey (WebAuthn P-256) signature
    function _validatePasskeySignature(bytes calldata signature, bytes32 userOpHash) internal view returns (uint256) {
        WebAuthn.WebAuthnAuth memory auth = abi.decode(signature, (WebAuthn.WebAuthnAuth));

        bool valid = WebAuthn.verify(
            abi.encodePacked(userOpHash),
            true, // requireUserVerification - CRITICAL for security
            auth,
            ownerX,
            ownerY
        );

        return valid ? 0 : 1;
    }

    /// @dev Validate a session key (agent) signature
    /// @notice Stores session key in transient storage for spend tracking in execution phase
    function _validateSessionKeySignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        returns (uint256)
    {
        // Decode: [sigType(1)] [sessionKeyAddr(20)] [signature(65)]
        if (userOp.signature.length < 86) return 1;

        address sessionKeyAddr = address(bytes20(userOp.signature[1:21]));
        bytes memory sig = userOp.signature[21:86];

        SessionKey storage sk = sessionKeys[sessionKeyAddr];

        // Check session key validity (use >= for precise expiry)
        if (block.timestamp >= sk.validUntil) return 1;

        // Check it's a whitelisted operation
        if (!_isWhitelistedOperation(userOp.callData)) return 1;

        // Extract amount and check against auto-execute threshold
        uint256 amount = _extractAmount(userOp.callData);
        if (amount > autoExecuteThreshold) return 1;

        // Check spend limit
        if (sk.spent + uint128(amount) > sk.spendLimit) return 1;

        // Verify ECDSA signature
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", userOpHash));

        (bytes32 r, bytes32 s, uint8 v) = _splitSignature(sig);

        // Check signature malleability (HIGH-1 fix)
        if (uint256(s) > SECP256K1_N_DIV_2) return 1;

        address recovered = ecrecover(ethSignedHash, v, r, s);

        if (recovered != sessionKeyAddr) return 1;

        // Store session key in transient storage for spend tracking (CRITICAL-1 fix)
        // This will be read by executeStrategy to update spent amount
        assembly {
            tstore(CURRENT_SESSION_KEY_SLOT, sessionKeyAddr)
        }

        return 0;
    }

    /*//////////////////////////////////////////////////////////////
                          STRATEGY EXECUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Execute a whitelisted protocol operation
    /// @dev Can be called via UserOp (passkey or session key signed)
    /// @param protocol The protocol address to interact with
    /// @param data The calldata for the protocol interaction
    function executeStrategy(address protocol, bytes calldata data) external onlyEntryPoint nonReentrant {
        if (!whitelistedProtocols[protocol]) revert ProtocolNotWhitelisted();

        uint256 amount = _extractAmountFromData(data);

        // Overflow check (HIGH-3 fix)
        if (amount > type(uint128).max) revert AmountOverflow();

        _updateDailySpend(amount);

        // Track session key spending (CRITICAL-1 fix)
        _updateSessionKeySpend(uint128(amount));

        (bool success,) = protocol.call(data);
        require(success, "Strategy execution failed");

        emit StrategyExecuted(protocol, bytes4(data[:4]), amount);
    }

    /*//////////////////////////////////////////////////////////////
                           OWNER FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Withdraw tokens to any address (requires passkey signature)
    /// @param token The token address to withdraw
    /// @param to The recipient address
    /// @param amount The amount to withdraw
    function withdraw(address token, address to, uint256 amount) external onlyEntryPoint nonReentrant {
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Grant a session key for agent operations
    /// @param key The session key address
    /// @param validUntil Unix timestamp when the key expires
    /// @param spendLimit Maximum cumulative spend for this key
    function grantSessionKey(address key, uint48 validUntil, uint128 spendLimit) external onlyEntryPoint {
        sessionKeys[key] = SessionKey({validUntil: validUntil, spendLimit: spendLimit, spent: 0});
        emit SessionKeyGranted(key, validUntil, spendLimit);
    }

    /// @notice Revoke a session key
    /// @param key The session key address to revoke
    function revokeSessionKey(address key) external onlyEntryPoint {
        delete sessionKeys[key];
        emit SessionKeyRevoked(key);
    }

    /// @notice Update protocol whitelist
    /// @param protocol The protocol address
    /// @param status Whether to whitelist (true) or remove (false)
    function setProtocolWhitelist(address protocol, bool status) external onlyEntryPoint {
        whitelistedProtocols[protocol] = status;
        emit ProtocolWhitelisted(protocol, status);
    }

    /// @notice Update auto-execute threshold
    /// @param newThreshold New threshold amount (6 decimals)
    function setAutoExecuteThreshold(uint128 newThreshold) external onlyEntryPoint {
        emit AutoExecuteThresholdUpdated(autoExecuteThreshold, newThreshold);
        autoExecuteThreshold = newThreshold;
    }

    /// @notice Update daily spending limit
    /// @param newLimit New daily limit (6 decimals)
    function setDailyLimit(uint128 newLimit) external onlyEntryPoint {
        emit DailyLimitUpdated(dailyLimit, newLimit);
        dailyLimit = newLimit;
    }

    /// @notice Update cumulative session key daily cap (C2 fix)
    /// @param newCap New session key daily cap (6 decimals)
    function setSessionKeyDailyCap(uint128 newCap) external onlyEntryPoint {
        emit SessionKeyDailyCapUpdated(sessionKeyDailyCap, newCap);
        sessionKeyDailyCap = newCap;
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Get remaining daily spending allowance
    function getAvailableDailyLimit() external view returns (uint256) {
        uint64 today = uint64(block.timestamp / 1 days);
        if (today > lastResetDay) {
            return dailyLimit;
        }
        return dailyLimit > dailySpent ? dailyLimit - dailySpent : 0;
    }

    /// @notice Get remaining session key daily allowance (C2 fix)
    function getAvailableSessionKeyDailyLimit() external view returns (uint256) {
        uint64 today = uint64(block.timestamp / 1 days);
        if (today > sessionKeyLastResetDay) {
            return sessionKeyDailyCap;
        }
        return sessionKeyDailyCap > sessionKeyDailySpent ? sessionKeyDailyCap - sessionKeyDailySpent : 0;
    }

    /// @notice Check if a protocol is whitelisted
    function isProtocolWhitelisted(address protocol) external view returns (bool) {
        return whitelistedProtocols[protocol];
    }

    /// @notice Get session key details
    function getSessionKey(address key) external view returns (uint48 validUntil, uint128 spendLimit, uint128 spent) {
        SessionKey storage sk = sessionKeys[key];
        return (sk.validUntil, sk.spendLimit, sk.spent);
    }

    /*//////////////////////////////////////////////////////////////
                          INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Update daily spending tracker
    function _updateDailySpend(uint256 amount) internal {
        uint64 today = uint64(block.timestamp / 1 days);
        if (today > lastResetDay) {
            dailySpent = 0;
            lastResetDay = today;
        }
        dailySpent += uint128(amount);
        if (dailySpent > dailyLimit) revert DailyLimitExceeded();
    }

    /// @dev Update session key spending using transient storage (CRITICAL-1 fix)
    /// @notice Reads session key from transient storage (set during validation) and updates spent
    /// @notice Also enforces cumulative daily cap across ALL session keys (C2 fix)
    function _updateSessionKeySpend(uint128 amount) internal {
        address sessionKeyAddr;
        assembly {
            sessionKeyAddr := tload(CURRENT_SESSION_KEY_SLOT)
        }

        // If no session key was used (passkey auth), skip
        if (sessionKeyAddr == address(0)) return;

        // C2 FIX: Check and update cumulative daily session key spending
        uint64 today = uint64(block.timestamp / 1 days);
        if (today > sessionKeyLastResetDay) {
            sessionKeyDailySpent = 0;
            sessionKeyLastResetDay = today;
        }

        // Enforce cumulative cap across ALL session keys
        if (sessionKeyDailySpent + amount > sessionKeyDailyCap) {
            revert SessionKeyDailyCapExceeded();
        }
        sessionKeyDailySpent += amount;

        // Update per-key spent amount
        sessionKeys[sessionKeyAddr].spent += amount;

        // Clear transient storage
        assembly {
            tstore(CURRENT_SESSION_KEY_SLOT, 0)
        }
    }

    /// @dev Check if operation targets executeStrategy with whitelisted protocol
    function _isWhitelistedOperation(bytes calldata callData) internal view returns (bool) {
        if (callData.length < 4) return false;
        bytes4 selector = bytes4(callData[:4]);

        // Only allow executeStrategy calls
        if (selector != this.executeStrategy.selector) return false;

        // Decode protocol address from calldata
        if (callData.length < 36) return false;
        address protocol = abi.decode(callData[4:36], (address));

        return whitelistedProtocols[protocol];
    }

    /// @dev Extract amount from executeStrategy calldata
    function _extractAmount(bytes calldata callData) internal pure returns (uint256) {
        if (callData.length < 68) return 0;

        // callData = executeStrategy(address protocol, bytes data)
        // Skip selector (4) + protocol address (32) = 36
        // Then decode the bytes offset and length
        (, bytes memory data) = abi.decode(callData[4:], (address, bytes));

        return _extractAmountFromData(data);
    }

    /// @dev Extract amount from protocol call data (C3 fix - protocol-specific extractors)
    /// @notice Handles each DeFi protocol's specific function signature
    function _extractAmountFromData(bytes memory data) internal pure returns (uint256 amount) {
        if (data.length < 36) return 0;

        bytes4 selector;
        assembly {
            // Load selector from data (skip 32 bytes length prefix)
            selector := mload(add(data, 32))
        }

        // Aave V3: supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)
        // Amount is second parameter (bytes 36-68)
        if (selector == AAVE_SUPPLY_SELECTOR || selector == AAVE_WITHDRAW_SELECTOR) {
            if (data.length < 68) return 0;
            assembly {
                amount := mload(add(data, 68)) // skip length(32) + selector(4) + address(32)
            }
            return amount;
        }

        // Compound V3: supply(address asset, uint256 amount) / withdraw(address asset, uint256 amount)
        // Amount is second parameter (bytes 36-68)
        if (selector == COMPOUND_SUPPLY_SELECTOR || selector == COMPOUND_WITHDRAW_SELECTOR) {
            if (data.length < 68) return 0;
            assembly {
                amount := mload(add(data, 68))
            }
            return amount;
        }

        // Morpho Blue: supply(MarketParams memory, uint256 assets, uint256 shares, address onBehalf, bytes data)
        // MarketParams is a struct (5 * 32 bytes = 160 bytes offset pointer), then assets is next
        // The struct is passed as reference, so first param is offset (32 bytes), then assets at position 2
        // Actually: selector(4) + offset(32) + assets(32) + shares(32) + ...
        // Assets is at bytes 36-68
        if (selector == MORPHO_SUPPLY_SELECTOR || selector == MORPHO_WITHDRAW_SELECTOR) {
            if (data.length < 68) return 0;
            // Morpho uses assets as the second parameter (first is struct offset)
            assembly {
                amount := mload(add(data, 68))
            }
            return amount;
        }

        // ERC4626/Moonwell: deposit(uint256 assets, address receiver)
        // Amount is FIRST parameter (bytes 4-36)
        if (selector == ERC4626_DEPOSIT_SELECTOR) {
            assembly {
                amount := mload(add(data, 36)) // skip length(32) + selector(4)
            }
            return amount;
        }

        // ERC4626/Moonwell: withdraw(uint256 assets, address receiver, address owner)
        // Amount is FIRST parameter (bytes 4-36)
        if (selector == ERC4626_WITHDRAW_SELECTOR) {
            assembly {
                amount := mload(add(data, 36))
            }
            return amount;
        }

        // Moonwell cToken: mint(uint256 mintAmount) / redeem(uint256 redeemTokens)
        // Amount is ONLY parameter (bytes 4-36)
        if (selector == CTOKEN_MINT_SELECTOR || selector == CTOKEN_REDEEM_SELECTOR) {
            assembly {
                amount := mload(add(data, 36))
            }
            return amount;
        }

        // Unknown selector - revert to prevent bypass attacks
        // An attacker cannot craft calldata with an unknown selector to bypass limits
        revert NotWhitelistedOperation();
    }

    /// @dev Split ECDSA signature into r, s, v components
    function _splitSignature(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "Invalid signature length");
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    /*//////////////////////////////////////////////////////////////
                              OVERRIDES
    //////////////////////////////////////////////////////////////*/

    /// @dev Override to disable standard owner() checks since we use passkeys
    function _checkOwner() internal view override {
        // Only allow calls from this contract (via execute) or EntryPoint
        if (msg.sender != address(this) && msg.sender != entryPoint()) {
            revert Unauthorized();
        }
    }

    /// @dev Return address(1) as owner to satisfy Solady's ownership checks
    /// The actual ownership is via passkey (ownerX, ownerY)
    function owner() public view override returns (address) {
        // Return a non-zero address to indicate the contract is initialized
        // Actual auth is via passkey validation
        return ownerX != 0 ? address(1) : address(0);
    }

    /// @dev Disable LibZip fallback for simpler contract
    function _useLibZipCdFallback() internal pure override returns (bool) {
        return false;
    }

    /// @dev Disable inherited execute() to enforce security controls (CRITICAL-2 fix)
    /// @notice All operations must go through executeStrategy (with whitelist) or withdraw
    function execute(address, uint256, bytes calldata) public payable override returns (bytes memory) {
        revert DirectExecuteDisabled();
    }

    /// @dev Disable inherited executeBatch() to enforce security controls (CRITICAL-2 fix)
    function executeBatch(Call[] calldata) public payable override returns (bytes[] memory) {
        revert DirectExecuteDisabled();
    }

    /// @dev EIP-712 domain name and version for signature verification
    function _domainNameAndVersion() internal pure override returns (string memory name, string memory version) {
        name = "AgentVault";
        version = "1";
    }
}
