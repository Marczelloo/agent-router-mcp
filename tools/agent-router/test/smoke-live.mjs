#!/usr/bin/env node
/**
 * Read-only smoke test against the REAL `codex app-server`.
 *
 * Only calls codex_get_models and codex_get_limits — no turn is started, so it
 * spends no Codex quota. Use it to verify the install and the login.
 *
 *   npm run smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "dist", "index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: process.env,
  stderr: "inherit",
});
const client = new Client({ name: "agent-router-smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

async function call(name) {
  const res = await client.callTool({ name, arguments: {} });
  const text = res.content.map((c) => c.text).join("\n");
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

const models = await call("codex_get_models");
console.log(`\nmodels (${models.models.length}), default = ${models.defaultModel}`);
for (const m of models.models) {
  console.log(`  ${m.id.padEnd(16)} efforts: ${m.reasoningEfforts.map((r) => r.effort).join(", ")}`);
}

const limits = await call("codex_get_limits");
console.log(`\nplan: ${limits.planType}   quota: ${limits.quota.state}`);
for (const w of limits.windows) {
  console.log(
    `  ${w.window.padEnd(8)} used ${String(w.usedPercent).padStart(5)}%  left ${String(
      w.remainingPercent,
    ).padStart(5)}%  resets ${w.resetsAt ?? "n/a"}  reached=${w.rateLimitReached}`,
  );
}
console.log(`\n${limits.quota.reason}`);

await client.close();
process.exit(0);
