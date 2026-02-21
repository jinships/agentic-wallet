// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LibClone} from "solady/utils/LibClone.sol";
import {AgentVault} from "./AgentVault.sol";

/// @title AgentVaultFactory
/// @notice Factory for deploying AgentVault instances with deterministic addresses
/// @dev Uses CREATE2 for counterfactual deployment - address is known before deployment
/// @author jinbang/agentic-wallet
contract AgentVaultFactory {
    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event VaultCreated(address indexed vault, uint256 indexed ownerX, uint256 indexed ownerY, bytes32 salt);

    /*//////////////////////////////////////////////////////////////
                               IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice Address of the AgentVault implementation contract
    address public immutable implementation;

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param _implementation Address of the AgentVault implementation
    constructor(address _implementation) payable {
        implementation = _implementation;
    }

    /*//////////////////////////////////////////////////////////////
                            DEPLOY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploy a new AgentVault or return existing one
    /// @dev Uses CREATE2 for deterministic addresses. Vault address can be computed before deployment.
    /// @param ownerX P-256 public key X coordinate
    /// @param ownerY P-256 public key Y coordinate
    /// @param protocols Initial whitelisted protocol addresses
    /// @param dailyLimit Maximum daily spend (6 decimals)
    /// @param autoExecuteThreshold Auto-execute threshold (default 0)
    /// @param sessionKeyDailyCap Cumulative daily cap for all session key spending
    /// @param salt Additional salt for address derivation
    /// @return vault The deployed (or existing) vault address
    function createVault(
        uint256 ownerX,
        uint256 ownerY,
        address[] calldata protocols,
        uint128 dailyLimit,
        uint128 autoExecuteThreshold,
        uint128 sessionKeyDailyCap,
        bytes32 salt
    ) external payable returns (address vault) {
        // Combine owner pubkey with salt for unique deterministic address
        bytes32 combinedSalt = keccak256(abi.encodePacked(ownerX, ownerY, salt));

        // Deploy minimal ERC1967 proxy pointing to implementation
        (bool alreadyDeployed, address account) =
            LibClone.createDeterministicERC1967(msg.value, implementation, combinedSalt);

        if (!alreadyDeployed) {
            // Initialize the vault with passkey and configuration
            AgentVault(payable(account))
                .initialize(ownerX, ownerY, protocols, dailyLimit, autoExecuteThreshold, sessionKeyDailyCap);

            emit VaultCreated(account, ownerX, ownerY, salt);
        }

        return account;
    }

    /// @notice Compute the vault address without deploying
    /// @dev Use this for counterfactual deployment - users can send funds before vault exists
    /// @param ownerX P-256 public key X coordinate
    /// @param ownerY P-256 public key Y coordinate
    /// @param salt Additional salt for address derivation
    /// @return The deterministic vault address
    function getVaultAddress(uint256 ownerX, uint256 ownerY, bytes32 salt) external view returns (address) {
        bytes32 combinedSalt = keccak256(abi.encodePacked(ownerX, ownerY, salt));
        return LibClone.predictDeterministicAddressERC1967(implementation, combinedSalt, address(this));
    }

    /// @notice Get the initialization code hash for the vault proxy
    /// @dev Useful for mining vanity addresses
    function initCodeHash() external view returns (bytes32) {
        return LibClone.initCodeHashERC1967(implementation);
    }
}
