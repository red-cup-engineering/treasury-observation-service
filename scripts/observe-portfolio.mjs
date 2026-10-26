#!/usr/bin/env node
/**
 * Public JSON portfolio request: resolve registered chain selections and compose the original
 * Treasury observers. The same input schema supplies agent validation and human form fields.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { validateJson } from "@red-cup-engineering/json-schema-services-section/validation";
import { chain } from "../src/chains.mjs";
import { observePortfolio } from "../src/portfolio.mjs";
import inputSchema from "../schemas/observe-portfolio.input.schema.json" with { type: "json" };

export async function observePortfolioReport(input, injected = {}) {
  const validation = validateJson({ value: input, schema: inputSchema });
  if (!validation.valid) {
    throw new TypeError(`portfolio: invalid request: ${JSON.stringify(validation.errors)}`);
  }
  return observePortfolio({
    ...input,
    ...(input.chains === undefined ? {} : { chains: input.chains.map((id) => chain(id)) }),
  }, injected);
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { input: { type: "string", default: "-" } } });
    let bytes;
    if (values.input === "-") {
      const chunks = [];
      let length = 0;
      for await (const chunk of process.stdin) {
        length += chunk.byteLength;
        if (length > 1_048_576) throw new RangeError("portfolio: request exceeds 1 MiB");
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    } else bytes = await readFile(values.input);
    if (bytes.byteLength > 1_048_576) throw new RangeError("portfolio: request exceeds 1 MiB");
    const report = await observePortfolioReport(JSON.parse(bytes.toString("utf8")));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.coverage.complete) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 2;
  }
}

