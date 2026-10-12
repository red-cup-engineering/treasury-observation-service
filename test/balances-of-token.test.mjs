import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { chain } from "../src/chains.mjs";
import { balancesOfToken, MULTICALL3 } from "../src/tokens.mjs";

const multicall3 = new Interface(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"]);
const erc20 = new Interface(["function balanceOf(address) view returns (uint256)"]);
const A = "0x32886F6F361C1d570255c2762967A2e41D0E9B1a";
const B = "0x01efd40106962297846649bc14a462600D75e5bC";

test("many addresses' balances of one token are read in one aggregate3 call; a reverted read is unlearned, never zero", async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    assert.equal(body.params[0].to, MULTICALL3);
    const result = multicall3.encodeFunctionResult("aggregate3", [[[true, erc20.encodeFunctionResult("balanceOf", [30000n])], [false, "0x"]]]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  };
  const readings = await balancesOfToken(chain("base"), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", [A, B], { fetchImpl });
  assert.equal(requests.length, 1);
  assert.deepEqual(readings, [{ address: A, checked: true, raw: "30000" }, { address: B, checked: false, reason: "balanceOf reverted" }]);
});
