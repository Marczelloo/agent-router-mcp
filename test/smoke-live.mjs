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
console.log(`\nrecommended models, default = ${models.defaultModel} / ${models.defaultEffort}`);
for (const m of models.recommended) {
  const efforts = m.available ? m.reasoningEfforts.map((r) => r.effort).join(", ") : "NOT AVAILABLE";
  console.log(`  ${m.id.padEnd(14)} ${m.tier.padEnd(9)} efforts: ${efforts}`);
}
if (models.otherModels.length > 0) {
  console.log(`other models: ${models.otherModels.map((m) => m.id).join(", ")}`);
}

const server = await call("codex_server");
console.log(`\ncodex ${server.appServer.codexVersion ?? "?"} (pid ${server.appServer.pid})`);

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
