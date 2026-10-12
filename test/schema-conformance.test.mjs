import { test } from "node:test";
import assert from "node:assert/strict";
import { validateJson } from "@red-cup-engineering/json-schema-services-section/validation";
import morphoInputSchema from "../schemas/observe-morpho-vault-position.input.schema.json" with { type: "json" };
import morphoOutputSchema from "../schemas/observe-morpho-vault-position.output.schema.json" with { type: "json" };
import rewardsInputSchema from "../schemas/observe-moonwell-claimable-rewards.input.schema.json" with { type: "json" };
import rewardsOutputSchema from "../schemas/observe-moonwell-claimable-rewards.output.schema.json" with { type: "json" };

function assertValid(value, schema, label) {
  const result = validateJson({ value, schema });
  assert.equal(result.valid, true, `${label}: ${JSON.stringify(result.errors)}`);
}

test("observe-morpho-vault-position schemas: input and every output shape validate", () => {
  assertValid({ owner: "0xCd6FA157359E3b9F88C31B95DD63A3D73A1F34cA", vault: "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61", principalAssetsRaw: "1000000", chainId: "base" }, morphoInputSchema, "input");
  assertValid({ chain: "base", vault: "v", owner: "o", checked: false, reason: "x", attempts: [] }, morphoOutputSchema, "output (unchecked)");
  assertValid({ chain: "base", vault: "v", owner: "o", checked: true, empty: true, shares: { raw: "0", decimals: 18, amount: "0" }, sources: ["a", "b"], apy: {} }, morphoOutputSchema, "output (empty)");
  assertValid({
    chain: "base", vault: "v", owner: "o", checked: true, empty: false,
    shares: { raw: "1", decimals: 18, amount: "1" }, asset: { address: "a", decimals: 6 }, assets: { raw: "1", amount: "1" },
    sources: ["a", "b"], apy: {}, accrued: {},
  }, morphoOutputSchema, "output (non-empty)");
});

test("observe-moonwell-claimable-rewards schemas: input and both output shapes validate", () => {
  assertValid({ wallet: "0xCd6FA157359E3b9F88C31B95DD63A3D73A1F34cA", distributor: "0xe9005b078701e2A0948D2EaC43010D35870Ad9d2" }, rewardsInputSchema, "input");
  assertValid({ chain: "base", distributor: "d", address: "a", checked: false, reason: "x", attempts: [] }, rewardsOutputSchema, "output (unchecked)");
  assertValid({ chain: "base", distributor: "d", address: "a", checked: true, rewards: [{ market: "m", emissionToken: "e", totalAmountRaw: "1" }] }, rewardsOutputSchema, "output (checked)");
});
