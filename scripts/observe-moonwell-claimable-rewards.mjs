#!/usr/bin/env node
/**
 * The claimable WELL (and any other emission token) a wallet can claim per Moonwell market on
 * Base. A thin CLI face over `src/rewards.mjs`'s `observeMoonwellOutstandingRewards`, which
 * already reports exactly this per-market breakdown -- no reward logic is reimplemented here.
 */
import { parseArgs } from "node:util";
import { chain } from "../src/chains.mjs";
import { observeMoonwellOutstandingRewards } from "../src/rewards.mjs";

/**
 * Reads one wallet's outstanding Moonwell rewards from one MultiRewardDistributor.
 * @param {{wallet: string, distributor: string, chainId?: string}} input
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<import("../src/rewards.d.ts").MoonwellOutstandingRewards>}
 */
export async function observeMoonwellClaimableRewards({ wallet, distributor, chainId = "base" }, options = {}) {
  return observeMoonwellOutstandingRewards(chain(chainId), distributor, wallet, options);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { wallet: { type: "string" }, distributor: { type: "string" }, chain: { type: "string" } },
  });
  if (!values.wallet || !values.distributor) {
    process.stderr.write("error: --wallet and --distributor are required\n");
    process.exitCode = 2;
  } else {
    const report = await observeMoonwellClaimableRewards({
      wallet: values.wallet, distributor: values.distributor, chainId: values.chain ?? "base",
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.checked === false) process.exitCode = 1;
  }
}
