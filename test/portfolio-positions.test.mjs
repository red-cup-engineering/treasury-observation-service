import { test } from "node:test";
import assert from "node:assert/strict";
import { validateJson } from "@red-cup-engineering/json-schema-services-section/validation";
import { observePortfolioReport } from "@red-cup-engineering/treasury-observation-service/observe-portfolio";
import inputSchema from "@red-cup-engineering/treasury-observation-service/schemas/observe-portfolio.input" with { type: "json" };
import outputSchema from "@red-cup-engineering/treasury-observation-service/schemas/observe-portfolio.output" with { type: "json" };
import { acquireObservationBoundary, CHAINS } from "../src/chains.mjs";
import { observeMorphoVaultPosition } from "../src/morpho.mjs";
import { observePortfolio } from "../src/portfolio.mjs";
import { WALLET, MARKET, VAULT, ASSET, BLOCK_TAG, BLOCK_HASH, CHANGED_HASH, portfolioRpc } from "./fixtures/portfolio-rpc.mjs";

const request = {
  roster: [{ subject: "urn:wallet:operating", address: WALLET }],
  chains: ["base"], finality: "latest",
  positions: { base: [{ kind: "compound-fork", address: MARKET }, { kind: "erc4626", address: VAULT }] },
};
function assertSchema(value, schema) {
  const result = validateJson({ value, schema });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
}

test("public portfolio preserves exact lending debt and vault assets when discovery fails", async () => {
  const { fetchImpl, calls } = portfolioRpc();
  assertSchema(request, inputSchema);
  const report = await observePortfolioReport(request, { fetchImpl });
  assertSchema(report, outputSchema);
  const chain = report.chains[0];
  const wallet = chain.wallets[0];
  const [lending, vault] = wallet.trackedPositions.positions;
  assert.equal(lending.checked, true);
  assert.equal(lending.contract, MARKET);
  assert.equal(lending.suppliedUnderlyingRaw, "20000000");
  assert.equal(lending.borrowedUnderlyingRaw, "2500000");
  assert.equal(lending.borrowedUnderlyingAmount, "2.5");
  assert.equal(lending.supplyRatePerTimestampMantissa, "100000000");
  assert.equal(vault.checked, true);
  assert.equal(vault.asset.address, ASSET);
  assert.equal(vault.shares.raw, "1000000000000000000");
  assert.equal(vault.assets.raw, "1050000");
  assert.equal(vault.assets.amount, "1.05");
  assert.equal(wallet.trackedPositions.checked, true);
  assert.equal(wallet.verifiedTokens.checked, false);
  assert.equal(report.coverage.complete, false);
  assert.deepEqual(chain.coverage.unchecked.map(({ component }) => component), ["verifiedTokens", "beefyPositions"]);
  for (const position of [lending, vault]) {
    assert.equal(position.provenance.blockHash, chain.provenance.blockHash);
    assert.equal(position.provenance.blockNumber, "100");
    assert.equal(position.provenance.finality, "unfinalized");
    assert.equal(position.provenance.provider, chain.provenance.provider);
  }
  const vaultReads = calls.filter(({ method, params }) => method === "eth_call" && params[0].to === VAULT);
  assert.deepEqual([...new Set(vaultReads.map(({ url }) => url))], CHAINS.base.rpc.slice(0, 2));
  assert.deepEqual([...new Set(vault.provenance.reads.map(({ provider }) => provider))], CHAINS.base.rpc.slice(0, 2));
  assert.ok(calls.filter(({ method }) => ["eth_getBalance", "eth_getTransactionCount", "eth_call"].includes(method))
    .every(({ params }) => params.at(-1) === BLOCK_TAG));
});

test("a second-source block mismatch leaves lending available and names the vault coverage gap", async () => {
  const { fetchImpl } = portfolioRpc({ indexerUnavailable: false, secondSourceHash: CHANGED_HASH });
  const report = await observePortfolioReport(request, { fetchImpl });
  assertSchema(report, outputSchema);
  const wallet = report.chains[0].wallets[0];
  assert.equal(wallet.trackedPositions.positions[0].checked, true);
  assert.equal(wallet.trackedPositions.positions[1].checked, false);
  assert.equal(wallet.trackedPositions.positions[1].contract, VAULT);
  assert.match(wallet.trackedPositions.positions[1].reason, /only one of two independent sources answered/);
  assert.deepEqual(report.chains[0].coverage.unchecked.map(({ component }) => component), ["trackedPositions"]);
});

test("ERC-4626 uses the same acquired block at two non-Base sources", async () => {
  const { fetchImpl, calls } = portfolioRpc({ chain: CHAINS.ethereum });
  const acquired = await acquireObservationBoundary(CHAINS.ethereum, { fetchImpl });
  const position = await observeMorphoVaultPosition(CHAINS.ethereum, VAULT, WALLET, {
    fetchImpl, boundary: acquired.value,
  });
  assert.equal(position.checked, true);
  assert.equal(position.assets.raw, "1050000");
  assert.equal(position.provenance.blockHash, BLOCK_HASH);
  assert.deepEqual(position.sources, CHAINS.ethereum.rpc.slice(0, 2));
  assert.ok(calls.filter(({ method }) => method === "eth_call").every(({ params }) => params.at(-1) === BLOCK_TAG));
});

test("a supplied pool cannot answer both scoped sources from one endpoint", async () => {
  const { fetchImpl } = portfolioRpc();
  const acquired = await acquireObservationBoundary(CHAINS.base, { fetchImpl });
  let readCalls = 0;
  const publicEvmReadPool = {
    async requestAtBoundary({ method, params, operation }) {
      if (operation) return { value: true, provider: { url: CHAINS.base.rpc[0] } };
      readCalls += 1;
      const response = await fetchImpl(CHAINS.base.rpc[0], { body: JSON.stringify({ method, params }) });
      return { value: (await response.json()).result, provider: { url: CHAINS.base.rpc[0] } };
    },
  };
  const result = await observeMorphoVaultPosition(CHAINS.base, VAULT, WALLET, {
    fetchImpl, boundary: acquired.value, publicEvmReadPool,
  });
  assert.equal(result.checked, false);
  assert.match(result.reason, /unselected chain endpoint/);
  assert.equal(readCalls, 2);
});

test("duplicate endpoint aliases and unregistered original boundary refuse before reads", async () => {
  let effects = 0;
  const fetchImpl = async () => { effects += 1; throw new Error("unexpected read"); };
  const duplicate = { ...CHAINS.base, rpc: ["https://example.org", "https://example.org/"] };
  const result = await observeMorphoVaultPosition(duplicate, VAULT, WALLET, { fetchImpl });
  assert.equal(result.checked, false);
  assert.match(result.reason, /two independent sources/);
  const boundary = {
    chain: "base", chainId: 8453, caip2: "eip155:8453", requestedFinality: "finalized", finality: "finalized",
    blockNumber: "100", blockTag: BLOCK_TAG, blockHash: BLOCK_HASH, provider: "https://unregistered.example",
    observedAt: new Date().toISOString(),
  };
  const unregistered = await observeMorphoVaultPosition(CHAINS.base, VAULT, WALLET, { fetchImpl, boundary });
  assert.equal(unregistered.checked, false);
  assert.match(unregistered.reason, /not registered/);
  assert.equal(effects, 0);
});

test("invalid public selections are rejected before provider effects", async () => {
  let effects = 0;
  const fetchImpl = async () => { effects += 1; throw new Error("unexpected read"); };
  for (const invalid of [
    { ...request, positions: { base: [{ kind: "unknown", address: MARKET }] } },
    { ...request, positions: { ethereum: [{ kind: "erc4626", address: VAULT }] } },
    { ...request, positions: { base: [request.positions.base[0], request.positions.base[0]] } },
    { ...request, concurrency: 17 },
    { ...request, secret: "unsupported-field" },
  ]) await assert.rejects(() => observePortfolioReport(invalid, { fetchImpl }), /portfolio:/);
  assert.equal(effects, 0);
});

test("the original queue bounds wallet observations and preserves roster order", async () => {
  const roster = Array.from({ length: 7 }, (_, index) => ({ subject: `urn:wallet:${index}`, address: WALLET }));
  let active = 0, peak = 0;
  const { fetchImpl } = portfolioRpc({ indexerUnavailable: false });
  const report = await observePortfolio({ roster, chains: [CHAINS.base], concurrency: 2 }, {
    fetchImpl,
    observeNative: async (_chain, address, options) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { checked: true, address, raw: "1", empty: false, provenance: options.boundary };
    },
  });
  assert.equal(peak, 2);
  assert.deepEqual(report.chains[0].wallets.map(({ subject }) => subject), roster.map(({ subject }) => subject));
  assert.equal(report.coverage.complete, true);
});


