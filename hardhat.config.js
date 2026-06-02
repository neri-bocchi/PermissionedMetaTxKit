// hardhat.config.js
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

export default {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      metadata: { bytecodeHash: "none" }, // <- MUY importante si el deploy se hizo así
    },
  },
  networks: {
    amoy: {
      url: process.env.RPC_URL || "https://rpc-amoy.polygon.technology/",
      accounts: process.env.RELAYER_PK ? [process.env.RELAYER_PK] : [],
      chainId: 80002,
      gasPrice: 25_000_000_000,   
    },
    lnettest: {
      url: process.env.RPC_URL || "http://35.185.112.219:4545",
      accounts: process.env.RELAYER_PK ? [process.env.RELAYER_PK] : [],
      chainId: 648540,
      gasPrice: 0,
      type: 0,
    },
    lnetmain: {
      url: process.env.RPC_URL || "http://34.73.228.200:4545",
      accounts: process.env.RELAYER_PK ? [process.env.RELAYER_PK] : [],
      chainId: 648541,
      gasPrice: 0,
      type: 0,
    },
  },
};

