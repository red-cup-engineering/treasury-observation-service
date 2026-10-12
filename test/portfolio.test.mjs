import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAINS, observePortfolio } from "../src/index.mjs";
import { observePortfolio as observePortfolioSubpath } from "@red-cup-engineering/treasury-observation-service/portfolio";

const SUBJECT = "urn:ame:wallet:yanagi";
const ADDRESS = "0x32886F6F361C1d570255c2762967A2e41D0E9B1a";
const VAULT = "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB";
const DISTRIBUTOR = "0xe9005b078701e2A0948D2EaC43010D35870Ad9d2";
const OBSERVED_AT = "2026-09-01T12:00:00.000Z";
const boundary = Object.freeze({
  chain: "base",
  chainId: 8453,
  caip2: "eip155:8453",
  requestedFinality: "finalized",
  finality: "finalized",
  blockNumber: "100",
  blockTag: "0x64",
  blockHash: `0x${"ab".repeat(32)}`,
  observedAt: OBSERVED_AT,
  provider: CHAINS.base.rpc[0],
});

function dependencies(overrides = {}) {
  return {
    now: () => new Date(OBSERVED_AT),
    acquireBoundary: async () => ({ ok: true, value: boundary, via: boundary.provider }),
    verifyBoundary: async () => ({ ok: true, value: boundary, via: boundary.provider }),
    observeNative: async (_chain, address) => ({
      chain: "base", caip2: "eip155:8453", address, checked: true,
      symbol: "ETH", decimals: 18, raw: "1", amount: "0.000000000000000001",
      empty: false, nonce: 1, via: boundary.provider, provenance: { ...boundary, reads: [] },
    }),
    observeTokens: async (_chain, address) => ({
      chain: "base", address, checked: true, via: "https://indexer.example", discovered: [],
      holdings: [{
        chain: "base", token: VAULT, address, checked: true, symbol: "mooTEST", decimals: 18,
        raw: "1000000000000000000", amount: "1", empty: false, via: boundary.provider,
        provenance: { ...boundary, reads: [] },
      }],
      provenance: { ...boundary, reads: [] },
    }),
    observeMoonwell: async (_chain, distributor, address) => ({
      chain: "base", distributor, address, checked: true, rewards: [{
        market: VAULT, emissionToken: VAULT, symbol: "WELL", decimals: 18,
        totalAmountRaw: "12", totalAmount: "0.000000000000000012",
        supplySideRaw: "12", borrowSideRaw: "0",
      }],
      provenance: { ...boundary, reads: [] },
    }),
    observeVault: async (_chain, vault, address) => ({
      chain: "base", vault, address, checked: true, empty: false,
      shares: { checked: true }, pricePerFullShareRaw: "1100000000000000000",
      underlyingRaw: "1100000000000000000", via: boundary.provider, priceSource: "onchain",
      provenance: { ...boundary, reads: [] },
    }),
    ...overrides,
  };
}

test("observePortfolio(): composes public subjects, balances, tokens, rewards, and Beefy positions", async () => {
  assert.equal(observePortfolioSubpath, observePortfolio);
  const report = await observePortfolio({
    roster: [{ subject: SUBJECT, address: ADDRESS.toLowerCase() }],
    chains: [CHAINS.base],
    moonwell: { base: { rewardDistributor: DISTRIBUTOR } },
  }, dependencies());

  assert.equal(report.observedAt, OBSERVED_AT);
  assert.deepEqual(report.roster, [{ subject: SUBJECT, address: ADDRESS }]);
  assert.equal(report.coverage.complete, true);
  const chain = report.chains[0];
  assert.equal(chain.checked, true);
  assert.equal(chain.provenance.blockHash, boundary.blockHash);
  assert.equal(chain.coverage.complete, true);
  const wallet = chain.wallets[0];
  assert.equal(wallet.subject, SUBJECT);
  assert.equal(wallet.address, ADDRESS);
  assert.equal(wallet.native.amount, "0.000000000000000001");
  assert.equal(wallet.native.valuation.priced, false);
  assert.equal(wallet.verifiedTokens.holdings[0].symbol, "mooTEST");
  assert.equal(wallet.verifiedTokens.holdings[0].valuation.priced, false);
  assert.equal(wallet.moonwellRewards.supported, true);
  assert.equal(wallet.moonwellRewards.rewards[0].symbol, "WELL");
  assert.deepEqual(wallet.moonwellRewards.valuation, {
    priced: false, usd: null, reason: "no USD valuation provider was supplied",
  });
  assert.equal(wallet.beefyPositions.positions[0].vault, VAULT);
  assert.equal(wallet.beefyPositions.positions[0].valuation.priced, false);
  assert.equal("readyClaimActions" in report, false);
});

test("observePortfolio(): token discovery failure stays unknown instead of becoming no positions", async () => {
  const report = await observePortfolio({
    roster: [{ subject: SUBJECT, address: ADDRESS }],
    chains: [CHAINS.base],
  }, dependencies({
    observeTokens: async () => ({
      chain: "base", address: ADDRESS, checked: false,
      reason: "indexer unreachable", attempts: [{ url: "https://indexer.example", error: "503" }], holdings: [],
    }),
  }));

  const wallet = report.chains[0].wallets[0];
  assert.equal(wallet.verifiedTokens.checked, false);
  assert.equal(wallet.beefyPositions.checked, false);
  assert.match(wallet.beefyPositions.reason, /indexer unreachable/);
  assert.equal("positions" in wallet.beefyPositions, false);
  assert.equal(wallet.moonwellRewards.supported, false);
  assert.equal(report.coverage.complete, false);
  assert.deepEqual(
    report.chains[0].coverage.unchecked.map(({ component }) => component).sort(),
    ["beefyPositions", "verifiedTokens"],
  );
});

test("observePortfolio(): an unreachable chain exposes no value-bearing partial observation", async () => {
  const report = await observePortfolio({
    roster: [{ subject: SUBJECT, address: ADDRESS }],
    chains: [CHAINS.base],
  }, dependencies({
    acquireBoundary: async () => ({
      ok: false, reason: "no finalized boundary", attempts: [{ url: CHAINS.base.rpc[0], error: "timeout" }],
    }),
  }));

  const chain = report.chains[0];
  assert.equal(chain.checked, false);
  assert.equal(chain.provenance, null);
  assert.equal(chain.wallets[0].checked, false);
  assert.equal("native" in chain.wallets[0], false);
  assert.deepEqual(report.coverage.incompleteChains, ["base"]);
});

test("observePortfolio(): failed boundary reconciliation invalidates collected values", async () => {
  const report = await observePortfolio({
    roster: [{ subject: SUBJECT, address: ADDRESS }], chains: [CHAINS.base],
  }, dependencies({
    verifyBoundary: async () => ({ ok: false, reason: "block hash changed", attempts: [] }),
  }));

  assert.equal(report.chains[0].checked, false);
  assert.equal(report.chains[0].provenance.blockHash, boundary.blockHash);
  assert.equal("native" in report.chains[0].wallets[0], false);
  assert.match(report.chains[0].wallets[0].reason, /could not be reconciled/);
});

test("observePortfolio(): validates roster and protocol configuration before effects", async () => {
  let effects = 0;
  const deps = dependencies({ acquireBoundary: async () => { effects += 1; return { ok: false }; } });
  await assert.rejects(
    () => observePortfolio({ roster: [{ subject: "", address: ADDRESS }], chains: [CHAINS.base] }, deps),
    /non-empty public subject/,
  );
  await assert.rejects(
    () => observePortfolio({ roster: [{ subject: SUBJECT, address: "not-an-address" }], chains: [CHAINS.base] }, deps),
    /not an EVM address/,
  );
  await assert.rejects(
    () => observePortfolio({
      roster: [{ subject: SUBJECT, address: ADDRESS }], chains: [CHAINS.base],
      moonwell: { ethereum: { rewardDistributor: DISTRIBUTOR } },
    }, deps),
    /unselected chain/,
  );
  assert.equal(effects, 0);
});

test("a failed token does not erase independently verified vault positions", async () => {
 const defaults=dependencies();
 const report=await observePortfolio({roster:[{subject:SUBJECT,address:ADDRESS}],chains:[CHAINS.base]},dependencies({observeTokens:async(...args)=>({...await defaults.observeTokens(...args),checked:false,reason:'another token has unavailable metadata'})}));
 const wallet=report.chains[0].wallets[0];
 assert.equal(report.coverage.complete,false);assert.equal(wallet.verifiedTokens.checked,false);assert.equal(wallet.beefyPositions.checked,false);
 assert.equal(wallet.beefyPositions.positions[0].vault,VAULT);assert.equal(wallet.beefyPositions.positions[0].checked,true);
 assert.match(wallet.beefyPositions.reason,/incomplete/);
});
