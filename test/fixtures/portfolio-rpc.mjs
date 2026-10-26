import { Interface } from "ethers";
import { CHAINS } from "../../src/chains.mjs";

export const WALLET = "0x1111111111111111111111111111111111111111";
export const MARKET = "0x2222222222222222222222222222222222222222";
export const VAULT = "0x3333333333333333333333333333333333333333";
export const ASSET = "0x4444444444444444444444444444444444444444";
export const BLOCK_TAG = "0x64";
export const BLOCK_HASH = `0x${"ab".repeat(32)}`;
export const CHANGED_HASH = `0x${"cd".repeat(32)}`;

const abi = new Interface([
  "function getAccountSnapshot(address) view returns (uint256,uint256,uint256,uint256)",
  "function symbol() view returns (string)",
  "function underlying() view returns (address)",
  "function supplyRatePerTimestamp() view returns (uint256)",
  "function borrowRatePerTimestamp() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
]);

export function portfolioRpc({ chain = CHAINS.base, indexerUnavailable = true, secondSourceHash = BLOCK_HASH } = {}) {
  const calls = [];
  const result = (value) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: value }) });
  const fetchImpl = async (url, init = {}) => {
    if (!init.body) {
      calls.push({ url, method: "GET" });
      return indexerUnavailable
        ? { ok: false, status: 503, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => [] };
    }
    const request = JSON.parse(init.body);
    calls.push({ url, ...request });
    if (request.method === "eth_chainId") return result(`0x${chain.chainId.toString(16)}`);
    if (request.method === "eth_getBlockByNumber") return result({
      number: BLOCK_TAG, timestamp: "0x64",
      hash: new URL(url).href === new URL(chain.rpc[1]).href ? secondSourceHash : BLOCK_HASH,
    });
    if (request.method === "eth_getBalance") return result("0xde0b6b3a7640000");
    if (request.method === "eth_getTransactionCount") return result("0x1");
    if (request.method !== "eth_call") throw new Error(`unexpected method ${request.method}`);
    const [{ to, data }] = request.params;
    const { name } = abi.parseTransaction({ data });
    const values = {
      getAccountSnapshot: [0n, 100_000_000n, 2_500_000n, 200_000_000_000_000_000n],
      symbol: ["mUSDC"], underlying: [ASSET], supplyRatePerTimestamp: [100_000_000n],
      borrowRatePerTimestamp: [200_000_000n], balanceOf: [1_000_000_000_000_000_000n],
      convertToAssets: [1_050_000n], convertToShares: [47_619n], asset: [ASSET],
      decimals: [to.toLowerCase() === ASSET.toLowerCase() ? 6 : 18],
    }[name];
    if (!values) throw new Error(`unexpected call ${name}`);
    return result(abi.encodeFunctionResult(name, values));
  };
  return { fetchImpl, calls };
}

