export const META_ABI_PRO = [
  "function execute((address,address,uint256,uint32,uint256,uint256,bytes32,address),bytes,bytes) payable",
  "function isNonceUsed(address,uint32,uint256) view returns (bool)",
  "function isCallerAllowed(address) view returns (bool)"
];

export const META_ABI_BASIC = [
  "function execute((address,address,uint256,uint32,uint256,uint256,bytes32),bytes,bytes) payable",
  "function isNonceUsed(address,uint32,uint256) view returns (bool)"
];

export const EXECUTE_SIG_PRO =
  "execute((address,address,uint256,uint32,uint256,uint256,bytes32,address),bytes,bytes)";

export const EXECUTE_SIG_BASIC =
  "execute((address,address,uint256,uint32,uint256,uint256,bytes32),bytes,bytes)";