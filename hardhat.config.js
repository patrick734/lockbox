require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { PRIVATE_KEY, BOT_RPC_URL, BOT_TESTNET_RPC_URL } = process.env;
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    // BOT Chain is a geth/BSC-lineage chain; "paris" avoids PUSH0/newer opcodes
    // in case the chain hasn't activated Shanghai/Cancun. Safe on any EVM chain.
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  networks: {
    botMainnet: {
      url: BOT_RPC_URL || "",
      chainId: 677, // BOT Chain Mainnet (ChainList)
      accounts,
    },
    botTestnet: {
      url: BOT_TESTNET_RPC_URL || "",
      accounts,
    },
  },
};

// Offline fallback: use the solc-js package from npm when the compiler CDN is unreachable.
if (process.env.USE_SOLCJS === "1") {
  const { subtask } = require("hardhat/config");
  const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
    if (args.solcVersion === "0.8.24") {
      const compilerPath = require.resolve("solc/soljson.js");
      return { compilerPath, isSolcJs: true, version: args.solcVersion, longVersion: "0.8.24+commit.e11b9ed9" };
    }
    return runSuper();
  });
}
