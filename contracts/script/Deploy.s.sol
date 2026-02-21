// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {AgentVaultFactory} from "../src/AgentVaultFactory.sol";

/// @notice Deployment script for AgentVault contracts
/// @dev Run with: forge script script/Deploy.s.sol --rpc-url base --broadcast --verify
contract DeployScript is Script {
    // Base mainnet protocol addresses
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant COMPOUND_USDC = 0xb125E6687d4313864e53df431d5425969c15Eb2F;
    address constant MORPHO_SPARK_VAULT = 0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A;
    address constant MOONWELL_USDC = 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22;

    function run() external {
        // Uses --account flag from command line (encrypted keystore)
        vm.startBroadcast();

        // Deploy implementation
        AgentVault implementation = new AgentVault();
        console2.log("AgentVault implementation deployed at:", address(implementation));

        // Deploy factory
        AgentVaultFactory factory = new AgentVaultFactory(address(implementation));
        console2.log("AgentVaultFactory deployed at:", address(factory));

        vm.stopBroadcast();

        // Log useful info
        console2.log("\n=== Deployment Complete ===");
        console2.log("Implementation:", address(implementation));
        console2.log("Factory:", address(factory));
        console2.log("\nWhitelisted protocols for vaults:");
        console2.log("- USDC:", USDC);
        console2.log("- Aave V3 Pool:", AAVE_POOL);
        console2.log("- Compound V3 (cUSDCv3):", COMPOUND_USDC);
        console2.log("- Morpho Spark Vault:", MORPHO_SPARK_VAULT);
        console2.log("- Moonwell mUSDC:", MOONWELL_USDC);
    }
}

/// @notice Script to create a new vault for a user
/// @dev Run with: forge script script/Deploy.s.sol:CreateVaultScript --rpc-url base --broadcast
contract CreateVaultScript is Script {
    // Base mainnet protocol addresses
    address constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address constant COMPOUND_USDC = 0xb125E6687d4313864e53df431d5425969c15Eb2F;
    address constant MORPHO_SPARK_VAULT = 0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A;
    address constant MOONWELL_USDC = 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22;

    function run() external {
        // These would come from the user's passkey registration
        uint256 ownerX = vm.envUint("PASSKEY_X");
        uint256 ownerY = vm.envUint("PASSKEY_Y");
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");

        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        AgentVaultFactory factory = AgentVaultFactory(factoryAddress);

        // Whitelist all 4 yield protocols
        address[] memory protocols = new address[](4);
        protocols[0] = AAVE_POOL;
        protocols[1] = COMPOUND_USDC;
        protocols[2] = MORPHO_SPARK_VAULT;
        protocols[3] = MOONWELL_USDC;

        // Create vault with:
        // - $10,000 daily limit
        // - $0 auto-execute threshold (all transactions require passkey)
        // - $1,000 session key daily cap
        address vault = factory.createVault(
            ownerX,
            ownerY,
            protocols,
            10000e6, // $10,000 daily limit
            0, // Auto-execute threshold: 0 (all require approval)
            1000e6, // Session key daily cap: $1,000
            bytes32(0)
        );

        vm.stopBroadcast();

        console2.log("Vault created at:", vault);
        console2.log("Owner X:", ownerX);
        console2.log("Owner Y:", ownerY);
    }
}

/// @notice Script to compute vault address without deploying
contract GetVaultAddressScript is Script {
    function run() external view {
        uint256 ownerX = vm.envUint("PASSKEY_X");
        uint256 ownerY = vm.envUint("PASSKEY_Y");
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");

        AgentVaultFactory factory = AgentVaultFactory(factoryAddress);
        address vaultAddress = factory.getVaultAddress(ownerX, ownerY, bytes32(0));

        console2.log("Predicted vault address:", vaultAddress);
        console2.log("Send USDC to this address, then deploy the vault.");
    }
}
