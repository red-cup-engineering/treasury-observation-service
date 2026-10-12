#!/usr/bin/env node
/**
 * One `{owner, vault}` position in a Morpho ERC-4626 vault on Base: share balance,
 * `convertToAssets`, the vault's current published APY, and accrued yield above a supplied
 * principal. Composes `src/morpho.mjs`; this file adds only CLI argument parsing and stdout.
 */
import { parseArgs } from "node:util";
import { chain } from "../src/chains.mjs";
import { deriveAccruedYield, fetchMorphoVaultApy, observeMorphoVaultPosition } from "../src/morpho.mjs";

/**
 * Observes one Morpho vault position and, when it is non-empty, folds in the vault's published
 * APY and the accrued yield above `principalAssetsRaw`.
 * @param {{owner: string, vault: string, principalAssetsRaw?: string, chainId?: string}} input
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<object>}
 */
export async function observeMorphoVaultPositionReport({ owner, vault, principalAssetsRaw, chainId = "base" }, options = {}) {
  const chainDescriptor = chain(chainId);
  const position = await observeMorphoVaultPosition(chainDescriptor, vault, owner, options);
  if (!position.checked) return position;

  const apy = await fetchMorphoVaultApy({ vault, chainId: chainDescriptor.chainId }, options);
  if (position.empty) return { ...position, apy };

  if (principalAssetsRaw === undefined) {
    return { ...position, apy, accrued: { checked: false, reason: "principalAssetsRaw was not supplied; accrued yield is never invented" } };
  }
  const accrued = deriveAccruedYield({ assetsRaw: position.assets.raw, principalAssetsRaw, decimals: position.asset.decimals });
  return { ...position, apy, accrued: { checked: true, ...accrued } };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      owner: { type: "string" },
      vault: { type: "string" },
      "principal-assets": { type: "string" },
      chain: { type: "string" },
    },
  });
  if (!values.owner || !values.vault) {
    process.stderr.write("error: --owner and --vault are required\n");
    process.exitCode = 2;
  } else {
    const report = await observeMorphoVaultPositionReport({
      owner: values.owner, vault: values.vault,
      principalAssetsRaw: values["principal-assets"], chainId: values.chain ?? "base",
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.checked === false) process.exitCode = 1;
  }
}
