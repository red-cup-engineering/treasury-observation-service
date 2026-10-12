/**
 * `contract-call` — one ABI-encoded `eth_call` against a chain descriptor's transport
 * (`chains.mjs`'s `call`), decoded back through the same `ethers.Interface`. The one shape
 * `positions.mjs` and `rewards.mjs` each read a contract method through.
 */
import { call, observationBlockTag } from "./chains.mjs";

/**
 * ABI-encodes `fn(args)` through `iface`, calls it via `chains.mjs`'s `call`, and decodes the
 * result through the same interface. Propagates a transport failure unchanged; a response the
 * interface cannot decode (an ABI mismatch) is reported as its own failure, never thrown.
 * @param {import("ethers").Interface} iface
 * @param {import("./chains.d.ts").ChainDescriptor} chainDescriptor
 * @param {string} to Contract address.
 * @param {string} fn Function name, as declared on `iface`.
 * @param {readonly unknown[]} args
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, boundary?: object}} [options]
 * @returns {Promise<{ok: true, value: import("ethers").Result, via: string, provenance?: object}
 *   | {ok: false, reason: string, attempts: object[]}>}
 */
export async function encoded(iface, chainDescriptor, to, fn, args, options) {
  const data = iface.encodeFunctionData(fn, args);
  const result = await call(chainDescriptor, "eth_call", [{ to, data }, observationBlockTag(options)], options);
  if (!result.ok) return result;
  try {
    const decoded = iface.decodeFunctionResult(fn, result.value);
    if (iface.encodeFunctionResult(fn, decoded).toLowerCase() !== result.value.toLowerCase()) {
      throw new TypeError("response does not match the complete canonical ABI result");
    }
    return {
      ok: true, value: decoded, via: result.via,
      ...(result.provenance === undefined ? {} : { provenance: result.provenance }),
    };
  } catch (error) {
    return { ok: false, reason: `malformed ${fn} response from ${result.via}: ${error.message}`, attempts: [] };
  }
}
