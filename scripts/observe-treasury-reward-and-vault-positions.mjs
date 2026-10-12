#!/usr/bin/env node
/**
 * Read the public AGRODAO wallet roster and print the Base treasury portfolio.
 *
 * This adapter supplies deployment-specific roster and protocol data to the reusable package
 * operation. It reads no wallet secret, constructs no transaction, and emits no claim action.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chain } from "../src/chains.mjs";
import { observePortfolio } from "../src/portfolio.mjs";

const BASE = chain("base");
const MULTI_REWARD_DISTRIBUTOR = "0xe9005b078701e2A0948D2EaC43010D35870Ad9d2";

function repoRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, ".git"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repository root not found above this script");
    dir = parent;
  }
  return dir;
}

function loadRoster() {
  const path = process.env.EVM_WALLET_FLEET_PATH
    ?? join(repoRoot(), "lib/emsenn/services/561-group/services/public-services-section/services/public-computer-services-section/services/public-web-services-section/services/public-web3-services-section/services/agrodao/content/observations/public-accounts/evm-wallet-fleet.json");
  const fleet = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(fleet.wallets)) throw new TypeError(`wallet fleet at ${path} has no wallets array`);
  return fleet.wallets.map(({ subject, address }) => ({ subject, address }));
}

async function main() {
  const report = await observePortfolio({
    roster: loadRoster(),
    chains: [BASE],
    moonwell: { base: { rewardDistributor: MULTI_REWARD_DISTRIBUTOR } },
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
