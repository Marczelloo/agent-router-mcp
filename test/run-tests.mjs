#!/usr/bin/env node
/**
 * End-to-end tests for the Agent Router MCP server.
 *
 * Each case boots the real MCP server over stdio, but points it at
 * test/fake-app-server.mjs instead of `codex app-server`, so the whole
 * router — JSON-RPC client, notification wiring, quota policy, task store —
 * is exercised without spending Codex quota.
 *
 *   node test/run-tests.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import jpeg from "jpeg-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "dist", "index.js");
const fakeServer = path.join(here, "fake-app-server.mjs");

if (!fs.existsSync(entry)) {
  console.error("dist/index.js not found — run `npm run build` first.");
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

async function withServer(scenario, env, fn) {
  const stateFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-test-")),
    "tasks.json",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      AGENT_ROUTER_CODEX_BIN: process.execPath,
      AGENT_ROUTER_CODEX_ARGS: JSON.stringify([fakeServer]),
      AGENT_ROUTER_STATE_FILE: stateFile,
      FAKE_SCENARIO: scenario,
      ...env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "agent-router-tests", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args = {}, options = undefined) => {
    const res = await client.callTool({ name, arguments: args }, undefined, options);
    const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const images = res.content.filter((c) => c.type === "image");
    try {
      return { isError: res.isError ?? false, data: JSON.parse(text), text, images };
    } catch {
      return { isError: res.isError ?? false, data: null, text, images };
    }
  };
  try {
    await fn(call);
  } finally {
    await client.close();
  }
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cwd-"));
const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-wt-"));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** A throwaway repository with one commit, an ignored directory, and one tracked file. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-repo-"));
  const g = (args, at) =>
    execFileSync("git", args, { cwd: at ?? dir, encoding: "utf8", env: GIT_ENV });
  g(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "app.js"), "original");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/");
  fs.mkdirSync(path.join(dir, "ignored"));
  fs.writeFileSync(path.join(dir, "ignored", "keep.txt"), "keep me");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  return { dir, g };
}

function samePath(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// ---------------------------------------------------------------- tests

console.log("\nmodel policy");
await withServer("success", {}, async (call) => {
  const { data } = await call("codex_get_models");
  const byId = Object.fromEntries(data.recommended.map((m) => [m.id, m]));
  check("recommends the three policy models", ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"].every((id) => byId[id]));
  check("all three are available in the live catalogue", data.recommended.every((m) => m.available));
  check("the default is gpt-6-sol", data.defaultModel === "gpt-6-sol");
  const efforts = (id) => byId[id].reasoningEfforts.map((r) => r.effort).join(",");
  check("sol is capped at high", efforts("gpt-6-sol") === "low,medium,high", efforts("gpt-6-sol"));
  check("astra is capped at high", efforts("gpt-6-astra") === "low,medium,high", efforts("gpt-6-astra"));
  check("luna may go to xhigh", efforts("gpt-6-luna") === "low,medium,high,xhigh", efforts("gpt-6-luna"));
  check("tiers are labelled", byId["gpt-6-luna"].tier === "fast" && byId["gpt-6-astra"].tier === "frontier");
  check("each recommended model says what it is for", data.recommended.every((m) => m.useFor.length > 10));
  check("models outside the policy are listed separately", data.otherModels.some((m) => m.id === "gpt-5.5"));

  const byDefault = await call("codex_delegate", { task: "x", workingDirectory: cwd, waitSeconds: 20 });
  check("no model named -> gpt-6-sol", byDefault.data.model === "gpt-6-sol", byDefault.data.model);
  check("no effort named -> medium", byDefault.data.reasoningEffort === "medium", byDefault.data.reasoningEffort);

  const alias = await call("codex_delegate", { task: "x", workingDirectory: cwd, model: "astra", waitSeconds: 20 });
  check("aliases resolve (astra -> gpt-6-astra)", alias.data.model === "gpt-6-astra", alias.data.model);

  const tier = await call("codex_delegate", { task: "x", workingDirectory: cwd, model: "fast", waitSeconds: 20 });
  check("tier aliases resolve (fast -> gpt-6-luna)", tier.data.model === "gpt-6-luna", tier.data.model);

  const capped = await call("codex_delegate", {
    task: "x", workingDirectory: cwd, model: "gpt-6-sol", reasoningEffort: "max", waitSeconds: 20,
  });
  check("an effort above the cap is clamped, not refused", capped.data.status === "completed", capped.text.slice(0, 200));
  check("sol max -> high", capped.data.reasoningEffort === "high", capped.data.reasoningEffort);
  check("the clamp is reported", (capped.data.notes ?? []).some((n) => /capped at "high"/.test(n)));

  const lunaX = await call("codex_delegate", {
    task: "x", workingDirectory: cwd, model: "luna", reasoningEffort: "xhigh", waitSeconds: 20,
  });
  check("luna accepts xhigh unchanged", lunaX.data.reasoningEffort === "xhigh" && !lunaX.data.notes, JSON.stringify(lunaX.data.notes));

  const lunaMax = await call("codex_delegate", {
    task: "x", workingDirectory: cwd, model: "luna", reasoningEffort: "max", waitSeconds: 20,
  });
  check("luna max -> xhigh", lunaMax.data.reasoningEffort === "xhigh", lunaMax.data.reasoningEffort);

  const offPolicy = await call("codex_delegate", {
    task: "x", workingDirectory: cwd, model: "gpt-5.5", waitSeconds: 20,
  });
  check("a model outside the policy still runs", offPolicy.data.status === "completed");
  check(
    "but carries a note steering back to the policy",
    (offPolicy.data.notes ?? []).some((n) => /outside the router's model policy/.test(n)),
  );

  const cont = await call("codex_continue", {
    taskId: byDefault.data.taskId, instruction: "again", reasoningEffort: "ultra", waitSeconds: 20,
  });
  check(
    "codex_continue caps an effort-only change against the task's model",
    cont.data.reasoningEffort === "high",
    cont.data.reasoningEffort,
  );
});

console.log("\ncodex_get_limits");
await withServer("success", {}, async (call) => {
  const { data } = await call("codex_get_limits");
  check("labels the 300-min window as 5h", data.fiveHour?.window === "5h");
  check("labels the 10080-min window as weekly", data.weekly?.window === "weekly");
  check("5h window came from the primary slot", data.fiveHour?.slot === "primary");
  check("computes remainingPercent", data.fiveHour?.remainingPercent === 88);
  check("exposes resetsAt as ISO", typeof data.fiveHour?.resetsAt === "string");
  check("rateLimitReached is false when under limit", data.rateLimitReached === false);
  check("picks the tightest window", data.tightest?.window === "weekly");
  check("verdict allows delegation", data.quota?.state === "ok" && data.quota?.canDelegate === true);
});

console.log("\ncodex_delegate — happy path");
await withServer("success", {}, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Create hello.txt",
    workingDirectory: cwd,
    scope: "only hello.txt",
    model: "gpt-6-astra",
    reasoningEffort: "high",
    waitSeconds: 20,
  });
  check("status is completed", data.status === "completed", `got ${data.status}`);
  check("carries a Codex threadId", typeof data.threadId === "string" && data.threadId.length > 0);
  check("records the chosen model", data.model === "gpt-6-astra");
  check("records the chosen reasoning effort", data.reasoningEffort === "high");
  check("summary is the final agent message", data.summary?.includes("Created hello.txt"));
  check(
    "changedFiles collected from fileChange items",
    JSON.stringify(data.changedFiles) === JSON.stringify(["hello.txt (add)"]),
    JSON.stringify(data.changedFiles),
  );
  check("commands collected", data.commands?.includes("cat hello.txt"));
  check("plan collected", data.plan?.length === 2);
  check("diff returned", typeof data.diff === "string" && data.diff.includes("hello from codex"));
  check("originalTask preserved", data.originalTask === "Create hello.txt");
  check("scope preserved", data.scope === "only hello.txt");
  check("timestamps present", Boolean(data.timestamps?.createdAt && data.timestamps?.completedAt));

  const status = await call("codex_task_status", { taskId: data.taskId });
  check("codex_task_status finds the task", status.data.taskId === data.taskId);
  check("status survives as completed", status.data.status === "completed");

  const list = await call("codex_task_status");
  check("codex_task_status with no id lists tasks", Array.isArray(list.data.tasks));
});

console.log("\ncodex_continue");
await withServer("success", {}, async (call) => {
  const first = await call("codex_delegate", {
    task: "Create hello.txt",
    workingDirectory: cwd,
    waitSeconds: 20,
  });
  const second = await call("codex_continue", {
    taskId: first.data.taskId,
    instruction: "Now add a trailing newline.",
    waitSeconds: 20,
  });
  check("reuses the same taskId", second.data.taskId === first.data.taskId);
  check("reuses the same Codex thread", second.data.threadId === first.data.threadId);
  check("completes the follow-up turn", second.data.status === "completed");
  check("originalTask still points at the first instruction", second.data.originalTask === "Create hello.txt");

  const unknown = await call("codex_continue", { taskId: "does-not-exist", instruction: "hi" });
  check("rejects an unknown taskId", unknown.isError === true);
});

console.log("\nquota preflight (delegation refused before any thread starts)");
await withServer("success", { AGENT_ROUTER_QUOTA_BLOCK_PERCENT: "95" }, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Big refactor",
    workingDirectory: cwd,
    waitSeconds: 10,
  });
  check("status is quota_exhausted", data.status === "quota_exhausted", `got ${data.status}`);
  check("no Codex thread was started", data.threadId === null);
  check("originalTask returned for handoff", data.originalTask === "Big refactor");
  check("remainingWork tells Claude to finish it", typeof data.remainingWork === "string");
  check("limits attached to the handoff", Array.isArray(data.limits?.windows));
  check("changedFiles is an empty array", JSON.stringify(data.changedFiles) === "[]");
  check("nextStep forbids waiting for a reset", /do not wait/i.test(data.nextStep ?? ""));
});

console.log("\nquota low warning");
await withServer("success", { AGENT_ROUTER_QUOTA_LOW_PERCENT: "70" }, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Create hello.txt",
    workingDirectory: cwd,
    waitSeconds: 20,
  });
  check("still delegates", data.status === "completed", `got ${data.status}`);
  check("warns about low quota", typeof data.warning === "string" && /low/i.test(data.warning));
});

console.log("\nquota exhausted mid-turn (handoff)");
await withServer("quota_midturn", {}, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Long task",
    workingDirectory: cwd,
    waitSeconds: 20,
  });
  check("status is quota_exhausted", data.status === "quota_exhausted", `got ${data.status}`);
  check("thread id preserved for a later resume", typeof data.threadId === "string");
  check("carries the Codex error", data.error?.codexErrorInfo === "usageLimitExceeded");
  check("remainingWork present", typeof data.remainingWork === "string");
  check("fresh limits show the account as limited", data.limits?.rateLimitReached === true);
  check("nextStep forbids retrying Codex", /do not retry/i.test(data.nextStep ?? ""));
});

console.log("\nturn failure that is not a quota problem");
await withServer("fail", {}, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Broken task",
    workingDirectory: cwd,
    waitSeconds: 20,
  });
  check("status is failed", data.status === "failed", `got ${data.status}`);
  check("not misclassified as quota", data.status !== "quota_exhausted");
  check("error message surfaced", data.error?.message === "compile error");
});

console.log("\nlong-running turn -> pollable handle + interrupt");
await withServer("slow", {}, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Never ending",
    workingDirectory: cwd,
    waitSeconds: 1,
  });
  check("returns running instead of blocking", data.status === "running", `got ${data.status}`);
  check("hands back a pollable taskId", typeof data.taskId === "string");
  check("nextStep mentions polling", /codex_task_status/.test(data.nextStep ?? ""));

  const status = await call("codex_task_status", { taskId: data.taskId });
  check("task is still running when polled", status.data.status === "running");

  const stopped = await call("codex_interrupt", { taskId: data.taskId });
  check("interrupt reports interrupted", stopped.data.status === "interrupted", `got ${stopped.data.status}`);
});

console.log("\ninput validation");
await withServer("success", {}, async (call) => {
  const badDir = await call("codex_delegate", {
    task: "x",
    workingDirectory: path.join(cwd, "nope-does-not-exist"),
  });
  check("rejects a missing workingDirectory", badDir.isError === true);

  const badModel = await call("codex_delegate", {
    task: "x",
    workingDirectory: cwd,
    model: "not-a-real-model",
  });
  check("rejects an unknown model", badModel.isError === true);
  check("the error recommends policy models", /Recommended: .*gpt-6-sol/.test(badModel.text), badModel.text.slice(0, 200));

  const badEffort = await call("codex_delegate", {
    task: "x",
    workingDirectory: cwd,
    model: "gpt-6-luna",
    reasoningEffort: "banana",
  });
  check("rejects an effort the model does not support", badEffort.isError === true);
  check("and lists the efforts it allows", /low, medium, high, xhigh/.test(badEffort.text), badEffort.text.slice(0, 200));

  const unknownTask = await call("codex_task_status", { taskId: "nope" });
  check("rejects an unknown taskId", unknownTask.isError === true);
});

console.log("");
console.log("a turn that outlives waitSeconds still finishes");
await withServer("slow_complete", {}, async (call) => {
  const { data } = await call("codex_delegate", { task: "Long task", workingDirectory: cwd, waitSeconds: 1 });
  check("returns running while the caller waits", data.status === "running", data.status);
  await new Promise((r) => setTimeout(r, 3500));
  const later = await call("codex_task_status", { taskId: data.taskId });
  check(
    "becomes completed once Codex finishes, with nobody waiting",
    later.data.status === "completed",
    later.data.status,
  );
  check("completedAt is recorded", Boolean(later.data.timestamps?.completedAt));
  check("the late result is captured", /Finished the long task/.test(later.data.summary ?? ""));
  const more = await call("codex_continue", { taskId: data.taskId, instruction: "one more thing", waitSeconds: 1 });
  check("the task is not bricked — it accepts a follow-up", more.isError === false, more.text.slice(0, 160));
});

console.log("");
console.log("concurrent delegations");
await withServer("success", {}, async (call) => {
  const [a, b] = await Promise.all([
    call("codex_delegate", { task: "Task A", workingDirectory: cwd, waitSeconds: 20 }),
    call("codex_delegate", { task: "Task B", workingDirectory: cwd, waitSeconds: 20 }),
  ]);
  check("both complete", a.data.status === "completed" && b.data.status === "completed",
    `${a.data.status} / ${b.data.status}`);
  check("each gets its own taskId", a.data.taskId !== b.data.taskId);
  // Turn completion is routed by threadId, so two in-flight turns must never
  // share one — otherwise one delegation would resolve with the other's result.
  check("each gets its own Codex thread", a.data.threadId !== b.data.threadId,
    `${a.data.threadId} / ${b.data.threadId}`);
  check("results are not crossed", a.data.originalTask === "Task A" && b.data.originalTask === "Task B");

  const list = await call("codex_task_status");
  check("both are tracked", list.data.tasks.length >= 2);
});

console.log("");
console.log("writes rejected by the sandbox");
await withServer("write_blocked", {}, async (call) => {
  // In a git repository the router can verify from snapshots that nothing was
  // written, which is what entitles it to say so.
  const repo = makeRepo();
  const { data } = await call("codex_delegate", {
    task: "Create greeting.txt",
    workingDirectory: repo.dir,
    waitSeconds: 20,
  });
  check("the turn still reports as completed", data.status === "completed", data.status);
  check(
    "a rejected patch is NOT reported as a changed file",
    JSON.stringify(data.changedFiles) === "[]",
    JSON.stringify(data.changedFiles),
  );
  check(
    "it is reported separately as a failed write",
    (data.failedFileChanges ?? []).some((f) => f.startsWith("greeting.txt")),
    JSON.stringify(data.failedFileChanges),
  );
  check("a warning says nothing landed on disk", /could not write any files/i.test(data.warning ?? ""));
  check("the warning names the likely cause", /sandbox/i.test(data.warning ?? ""));
  check(
    "nextStep tells the lead not to review phantom files",
    /do not review/i.test(data.nextStep ?? ""),
    data.nextStep,
  );
});

console.log("");
console.log("git checkpoints");
await withServer("success", {}, async (call) => {
  const repo = makeRepo();
  const { data } = await call("codex_delegate", {
    task: "Touch the app",
    workingDirectory: repo.dir,
    waitSeconds: 20,
  });
  check("a checkpoint is taken before and after the turn", data.checkpoints.length === 2, JSON.stringify(data.checkpoints));
  check("phases are labelled", data.checkpoints[0].phase === "pre-turn" && data.checkpoints[1].phase === "post-turn");

  const listed = await call("codex_checkpoints", { taskId: data.taskId });
  check("codex_checkpoints reports them", listed.data.checkpoints.length === 2);
  check("checkpointing is reported as on", listed.data.checkpointing === "on");
  check("each checkpoint names a commit", /^[0-9a-f]{40}$/.test(listed.data.checkpoints[0].commit));

  // Simulate a turn that made things worse.
  const appFile = path.join(repo.dir, "app.js");
  const junkFile = path.join(repo.dir, "junk.txt");
  fs.writeFileSync(appFile, "BROKEN");
  fs.writeFileSync(junkFile, "junk");

  const restored = await call("codex_restore", { taskId: data.taskId, checkpointId: "cp-1" });
  check("restore succeeds", restored.data.status === "restored", restored.text.slice(0, 200));
  check("tracked file content is rolled back", fs.readFileSync(appFile, "utf8") === "original");
  check("files created after the checkpoint are kept by default", fs.existsSync(junkFile));
  check("those files are reported as leftovers", restored.data.leftoverFiles.includes("junk.txt"));
  check("a safety checkpoint is captured first", typeof restored.data.safetyCheckpoint?.id === "string");
  check("the leftover hint is present", typeof restored.data.hint === "string");

  const safetyId = restored.data.safetyCheckpoint.id;

  const purged = await call("codex_restore", {
    taskId: data.taskId,
    checkpointId: "cp-1",
    removeUntracked: true,
  });
  check("removeUntracked deletes the extra file", !fs.existsSync(junkFile));
  check("the deletion is reported", purged.data.removedFiles.includes("junk.txt"));
  check("gitignored files are never touched", fs.existsSync(path.join(repo.dir, "ignored", "keep.txt")));

  const undone = await call("codex_restore", {
    taskId: data.taskId,
    checkpointId: safetyId,
    removeUntracked: true,
  });
  check("a restore is itself undoable", undone.data.status === "restored");
  check("the pre-restore content comes back", fs.readFileSync(appFile, "utf8") === "BROKEN");
  check("and so do its untracked files", fs.existsSync(junkFile));

  const bogus = await call("codex_restore", { taskId: data.taskId, checkpointId: "cp-999" });
  check("rejects an unknown checkpoint", bogus.isError === true);
  check("lists the valid checkpoint ids", /cp-1/.test(bogus.text));

  // The user's staging area must survive all of that untouched.
  check("the user index was never disturbed", repo.g(["diff", "--cached", "--name-only"]).trim() === "");
});

console.log("");
console.log("checkpoints outside a git repository");
await withServer("success", {}, async (call) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ar-plain-"));
  const { data } = await call("codex_delegate", {
    task: "Work without git",
    workingDirectory: plain,
    waitSeconds: 20,
  });
  check("delegation still works", data.status === "completed");
  check("no checkpoints are invented", data.checkpoints.length === 0);
  const listed = await call("codex_checkpoints", { taskId: data.taskId });
  check("the reason is explained", /not a git repository/.test(listed.data.checkpointing));
});

console.log("");
console.log("worktree isolation");
await withServer("success", { AGENT_ROUTER_WORKTREE_ROOT: worktreeRoot }, async (call) => {
  const repo = makeRepo();
  const { data } = await call("codex_delegate", {
    task: "Build a feature",
    workingDirectory: repo.dir,
    isolation: "worktree",
    waitSeconds: 20,
  });
  check("delegation completed", data.status === "completed", data.text ?? data.status);
  check("isolation is recorded", data.isolation === "worktree");
  check("a dedicated branch is used", data.worktree?.branch === "agent-router/" + data.taskId);
  check("codex is pointed at the worktree", samePath(data.workingDirectory, data.worktree?.path));
  check("the requested directory is remembered", samePath(data.requestedDirectory, repo.dir));
  check("the worktree lives outside the repo", !samePath(path.dirname(data.worktree.path), repo.dir));
  check("the worktree exists on disk", fs.existsSync(data.worktree.path));
  check("the result explains the isolation", /Isolated on branch/.test(data.integration ?? ""));
  check("nextStep points at codex_worktree", /codex_worktree/.test(data.nextStep ?? ""));

  // Stand in for the work Codex would have done inside the worktree.
  fs.writeFileSync(path.join(data.worktree.path, "feature.js"), "shipped");
  fs.writeFileSync(path.join(data.worktree.path, "app.js"), "rewritten");

  check("the user working tree is untouched", fs.readFileSync(path.join(repo.dir, "app.js"), "utf8") === "original");
  check("and gains no new files", !fs.existsSync(path.join(repo.dir, "feature.js")));

  const status = await call("codex_task_status", { taskId: data.taskId });
  check(
    "status reports the cumulative worktree diff, not just the last turn",
    status.data.changedFiles.includes("feature.js (add)") &&
      status.data.changedFiles.includes("app.js (update)"),
    JSON.stringify(status.data.changedFiles),
  );

  const refused = await call("codex_worktree", { taskId: data.taskId, action: "remove" });
  check("removing a dirty worktree is refused", refused.isError === true);
  check("the refusal explains how to proceed", /commit/i.test(refused.text));

  const committed = await call("codex_worktree", { taskId: data.taskId, action: "commit" });
  check("committing works", committed.data.status === "committed", committed.text.slice(0, 200));
  check("the commit is on the task branch", committed.data.branch === data.worktree.branch);
  check("the merge command is handed back", /git merge/.test(committed.data.integration ?? ""));
  check(
    "the router did not merge into the user branch",
    fs.readFileSync(path.join(repo.dir, "app.js"), "utf8") === "original",
  );

  const removed = await call("codex_worktree", { taskId: data.taskId, action: "remove" });
  check("a clean worktree can be removed", removed.data.status === "removed");
  check("it is gone from disk", !fs.existsSync(data.worktree.path));
  check("the branch survives for merging", repo.g(["branch", "--list"]).includes(data.worktree.branch));

  const afterRemoval = await call("codex_continue", {
    taskId: data.taskId,
    instruction: "keep going",
  });
  check("continuing into a removed worktree is refused", afterRemoval.isError === true);
});

console.log("");
console.log("worktree validation");
await withServer("success", { AGENT_ROUTER_WORKTREE_ROOT: worktreeRoot }, async (call) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ar-nogit-"));
  const noRepo = await call("codex_delegate", {
    task: "x",
    workingDirectory: plain,
    isolation: "worktree",
  });
  check("worktree isolation needs a git repository", noRepo.isError === true);
  check("the error suggests isolation none", /isolation .*none/.test(noRepo.text));

  const repo = makeRepo();
  const inPlace = await call("codex_delegate", {
    task: "x",
    workingDirectory: repo.dir,
    waitSeconds: 20,
  });
  const noWorktree = await call("codex_worktree", { taskId: inPlace.data.taskId, action: "commit" });
  check("codex_worktree rejects a non-isolated task", noWorktree.isError === true);
  check("and says why", /isolation/.test(noWorktree.text));

  const named = await call("codex_delegate", {
    task: "x",
    workingDirectory: repo.dir,
    isolation: "worktree",
    branch: "feature/custom-name",
    waitSeconds: 20,
  });
  check("a custom branch name is honoured", named.data.worktree?.branch === "feature/custom-name");
});

console.log("");
console.log("codex_review (Claude -> Codex)");
await withServer("success", {}, async (call) => {
  const repo = makeRepo();
  const { data } = await call("codex_review", {
    workingDirectory: repo.dir,
    waitSeconds: 20,
  });
  check("review completes", data.status === "completed", data.status);
  check("it is recorded as a review task", data.kind === "review");
  check("the task id is namespaced", data.taskId.startsWith("review-"));
  check("findings come back in the summary", /REVIEW FINDINGS/.test(data.summary));
  check(
    "the default target is uncommitted changes",
    /"type":"uncommittedChanges"/.test(data.summary),
    data.summary,
  );
  check("the reviewer runs read-only", /"read-only"/.test(data.summary), data.summary);
  check("the reviewer is told not to edit", /do not edit files/i.test(data.summary));
  check("nextStep says nothing was changed", /nothing was changed/i.test(data.nextStep ?? ""));

  const onBranch = await call("codex_review", {
    workingDirectory: repo.dir,
    target: "baseBranch",
    branch: "main",
    waitSeconds: 20,
  });
  check("baseBranch target maps through", /"baseBranch"/.test(onBranch.data.summary));
  check("the branch is passed", /"branch":"main"/.test(onBranch.data.summary));

  const onCommit = await call("codex_review", {
    workingDirectory: repo.dir,
    target: "commit",
    commit: "deadbeef",
    waitSeconds: 20,
  });
  check("commit target maps through", /"sha":"deadbeef"/.test(onCommit.data.summary));

  const custom = await call("codex_review", {
    workingDirectory: repo.dir,
    target: "custom",
    instructions: "Only look at error handling.",
    waitSeconds: 20,
  });
  check("custom target carries the instructions", /Only look at error handling/.test(custom.data.summary));

  const guided = await call("codex_review", {
    workingDirectory: repo.dir,
    instructions: "Focus on the retry logic.",
    waitSeconds: 20,
  });
  check(
    "extra guidance reaches the reviewer for non-custom targets",
    /Focus on the retry logic/.test(guided.data.summary),
  );
});

console.log("");
console.log("cross-review (Codex reviews Codex, different model)");
await withServer("success", {}, async (call) => {
  const repo = makeRepo();
  const worked = await call("codex_delegate", {
    task: "Rewrite the parser",
    workingDirectory: repo.dir,
    scope: "only parser.js",
    model: "gpt-6-sol",
    waitSeconds: 20,
  });
  const reviewed = await call("codex_review", {
    taskId: worked.data.taskId,
    model: "gpt-6-luna",
    waitSeconds: 20,
  });
  check("the review runs", reviewed.data.status === "completed");
  check("a different model is used", reviewed.data.model === "gpt-6-luna");
  check("the review is linked to the task", reviewed.data.reviewOf?.taskId === worked.data.taskId);
  check(
    "the reviewer is told what the task was",
    /Rewrite the parser/.test(reviewed.data.summary),
    reviewed.data.summary,
  );
  check("and what scope applied", /only parser\.js/.test(reviewed.data.summary));
  check("and to flag scope violations", /outside that scope/i.test(reviewed.data.summary));

  const noTarget = await call("codex_review", {});
  check("review needs a directory or a task", noTarget.isError === true);

  const badTask = await call("codex_review", { taskId: "nope" });
  check("review rejects an unknown taskId", badTask.isError === true);

  const missingBranch = await call("codex_review", {
    workingDirectory: repo.dir,
    target: "baseBranch",
  });
  check("baseBranch without a branch is rejected", missingBranch.isError === true);
});

// ================================================================ control

const FAST_WATCHDOG = {
  AGENT_ROUTER_WATCHDOG_INTERVAL_SECONDS: "0.3",
  AGENT_ROUTER_INTERRUPT_GRACE_SECONDS: "1",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("");
console.log("codex_task_status can wait instead of polling");
await withServer("slow_complete", {}, async (call) => {
  const { data } = await call("codex_delegate", { task: "Long task", workingDirectory: cwd, waitSeconds: 1 });
  check("delegate hands back running", data.status === "running", data.status);
  check("running results carry live progress", typeof data.progress?.health === "string", JSON.stringify(data.progress));
  check("progress reports how long it has run", typeof data.progress?.runningSeconds === "number");
  check("nextStep says to wait, not re-delegate", /waitSeconds/.test(data.nextStep ?? "") && /do not re-delegate/.test(data.nextStep ?? ""));
  const waited = await call("codex_task_status", { taskId: data.taskId, waitSeconds: 10 });
  check("waitSeconds blocks until the task finishes", waited.data.status === "completed", waited.data.status);
  check("and returns the final result", /Finished the long task/.test(waited.data.summary ?? ""));
});

console.log("");
console.log("blocking calls send MCP progress notifications");
await withServer("slow_complete", { AGENT_ROUTER_PROGRESS_INTERVAL_SECONDS: "0.5" }, async (call) => {
  const events = [];
  const { data } = await call(
    "codex_delegate",
    { task: "Long task", workingDirectory: cwd, waitSeconds: 10 },
    { onprogress: (p) => events.push(p), resetTimeoutOnProgress: true },
  );
  check("the call still returns its result", data.status === "completed", data.status);
  check("progress arrived while it blocked", events.length >= 2, String(events.length));
  check("progress counts up", events.length >= 2 && events[events.length - 1].progress > events[0].progress);
  check("and says what is happening", /Codex is working/.test(events[0]?.message ?? ""), events[0]?.message);

  const quiet = [];
  await call("codex_get_models", {}, { onprogress: (p) => quiet.push(p) });
  check("instant calls send none", quiet.length === 0, String(quiet.length));
});

console.log("");
console.log("default wait stays under the common 60s client timeout");
await withServer("slow", {}, async (call) => {
  const t0 = Date.now();
  const { data } = await call("codex_delegate", { task: "Never ending", workingDirectory: cwd });
  const took = (Date.now() - t0) / 1000;
  check("returns running on its own, before 60s", data.status === "running" && took < 58, `${took.toFixed(1)}s`);
  await call("codex_interrupt", { taskId: data.taskId });
});

console.log("");
console.log("a lost turn/completed is recovered from the thread's real state");
await withServer("lost_completion", {}, async (call) => {
  const { data } = await call("codex_delegate", { task: "Quiet task", workingDirectory: cwd, waitSeconds: 1 });
  check("looks running at first (the completion never arrived)", data.status === "running", data.status);
  await sleep(2500); // the thread/status idle signal triggers a reconcile
  const later = await call("codex_task_status", { taskId: data.taskId });
  check("reconciled to completed without a turn/completed", later.data.status === "completed", later.data.status);
  check(
    "the reconciliation is recorded",
    (later.data.interventions ?? []).some((i) => i.action === "reconciled"),
    JSON.stringify(later.data.interventions),
  );
  const more = await call("codex_continue", { taskId: data.taskId, instruction: "next", waitSeconds: 1 });
  check("and the task accepts a follow-up", more.isError === false, more.text.slice(0, 160));
});

console.log("");
console.log("codex_interrupt when Codex ignores the interrupt");
await withServer("unresponsive", FAST_WATCHDOG, async (call) => {
  const { data } = await call("codex_delegate", { task: "Hang", workingDirectory: cwd, waitSeconds: 1 });
  check("starts running", data.status === "running", data.status);
  const t0 = Date.now();
  const stopped = await call("codex_interrupt", { taskId: data.taskId });
  check("the task leaves running anyway", stopped.data.status === "interrupted", stopped.data.status);
  check("the result says it was forced", stopped.data.forced === true, String(stopped.data.forced));
  check("within the grace period, not forever", Date.now() - t0 < 8000, `${Date.now() - t0}ms`);
  check(
    "the forced stop is recorded with a reason",
    (stopped.data.interventions ?? []).some((i) => i.action === "forced" && /did not confirm/.test(i.reason)),
  );
  const again = await call("codex_continue", { taskId: data.taskId, instruction: "retry", waitSeconds: 1 });
  check("the task is usable again after a forced stop", again.isError === false, again.text.slice(0, 160));
});

console.log("");
console.log("codex_interrupt when Codex confirms");
await withServer("slow", {}, async (call) => {
  const { data } = await call("codex_delegate", { task: "Never ending", workingDirectory: cwd, waitSeconds: 1 });
  const stopped = await call("codex_interrupt", { taskId: data.taskId });
  check("interrupted", stopped.data.status === "interrupted", stopped.data.status);
  check("not forced — Codex confirmed", stopped.data.forced === false, String(stopped.data.forced));
  const idle = await call("codex_interrupt", { taskId: data.taskId });
  check("interrupting a finished task is a no-op", idle.isError === false && idle.data.status === "interrupted");
});

console.log("");
console.log("watchdog: blocked on an approval nobody can give");
await withServer("blocked", { ...FAST_WATCHDOG, AGENT_ROUTER_BLOCKED_TIMEOUT_SECONDS: "1" }, async (call) => {
  const { data } = await call("codex_delegate", { task: "Needs approval", workingDirectory: cwd, waitSeconds: 1 });
  check("running", data.status === "running", data.status);
  const mid = await call("codex_task_status", { taskId: data.taskId, refresh: false });
  check("health reports blocked", mid.data.progress?.health === "blocked", JSON.stringify(mid.data.progress));
  check("and on what", mid.data.progress?.blockedOn === "waitingOnApproval");
  await sleep(3000);
  const later = await call("codex_task_status", { taskId: data.taskId });
  check("auto-interrupted by the watchdog", later.data.status === "interrupted", later.data.status);
  check(
    "with the reason recorded",
    (later.data.interventions ?? []).some((i) => i.action === "auto-interrupted" && /approval/.test(i.reason)),
    JSON.stringify(later.data.interventions),
  );
  check("nextStep explains the interruption", /interrupted \(/.test(later.data.nextStep ?? ""), later.data.nextStep);
});

console.log("");
console.log("watchdog: per-turn time limit");
await withServer("slow", FAST_WATCHDOG, async (call) => {
  const { data } = await call("codex_delegate", {
    task: "Runs too long", workingDirectory: cwd, waitSeconds: 1, timeoutSeconds: 1,
  });
  check("reports its deadline", typeof data.progress?.deadlineAt === "string");
  await sleep(3000);
  const later = await call("codex_task_status", { taskId: data.taskId });
  check("interrupted once past its deadline", later.data.status === "interrupted", later.data.status);
  check(
    "the time limit is given as the reason",
    (later.data.interventions ?? []).some((i) => /time limit/.test(i.reason)),
    JSON.stringify(later.data.interventions),
  );
});

console.log("");
console.log("watchdog: silence is flagged, not killed");
await withServer("slow", { ...FAST_WATCHDOG, AGENT_ROUTER_STALL_SECONDS: "1" }, async (call) => {
  const { data } = await call("codex_delegate", { task: "Silent command", workingDirectory: cwd, waitSeconds: 1 });
  await sleep(2500);
  const later = await call("codex_task_status", { taskId: data.taskId, refresh: false });
  check("still running — silence alone never kills", later.data.status === "running", later.data.status);
  check("health is stalled", later.data.progress?.health === "stalled", JSON.stringify(later.data.progress));
  const stalledNotes = (later.data.interventions ?? []).filter((i) => i.action === "stalled");
  check("the stall is recorded once, not on every sweep", stalledNotes.length === 1, String(stalledNotes.length));
  await call("codex_interrupt", { taskId: data.taskId });
});

console.log("");
console.log("codex_server");
await withServer("slow", {}, async (call) => {
  const idle = await call("codex_server", {});
  check("status works before any task", idle.isError === false);
  const { data } = await call("codex_delegate", { task: "Busy", workingDirectory: cwd, waitSeconds: 1 });
  const status = await call("codex_server", { action: "status" });
  check("reports the app-server as running", status.data.appServer.running === true);
  check("reports the Codex version", status.data.appServer.codexVersion === "0.155.1", status.data.appServer.codexVersion);
  check("lists the running task with its health", status.data.runningTasks.some((t) => t.taskId === data.taskId && t.health));
  check("exposes the watchdog settings", typeof status.data.watchdog.turnTimeoutSeconds === "number");
  const pidBefore = status.data.appServer.pid;

  const restarted = await call("codex_server", { action: "restart" });
  check("restart succeeds", restarted.data.status === "restarted", restarted.text.slice(0, 200));
  check("names the turns it interrupted", restarted.data.interruptedTasks.includes(data.taskId));
  check("a new process is running", restarted.data.appServer.running && restarted.data.appServer.pid !== pidBefore);

  const task = await call("codex_task_status", { taskId: data.taskId });
  check("the lost turn is interrupted, not left running", task.data.status === "interrupted", task.data.status);
  check("with the restart recorded", (task.data.interventions ?? []).some((i) => i.action === "app-server-restarted"));
  const works = await call("codex_get_models");
  check("the router keeps working after a restart", works.isError === false);
});

// ================================================================ images

console.log("");
console.log("codex_generate_image");
await withServer("image", {}, async (call) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-img-"));
  const one = await call("codex_generate_image", {
    prompt: "A red square icon",
    workingDirectory: out,
    waitSeconds: 20,
  });
  check("completes", one.data.status === "completed", one.text.slice(0, 200));
  check("is an image task", one.data.kind === "image");
  check("defaults to the cheap model", one.data.model === "gpt-6-luna" && one.data.reasoningEffort === "low",
    `${one.data.model}/${one.data.reasoningEffort}`);
  const img = one.data.images?.[0];
  check("reports the saved image", Boolean(img));
  check("in generated-images/<slug>.png by default", img && img.path.endsWith(path.join("generated-images", "a-red-square-icon.png")), img?.path);
  check("the file exists on disk", img && fs.existsSync(img.path));
  check("with its real dimensions", img && img.width === 96 && img.height === 64, `${img?.width}x${img?.height}`);
  check("and the revised prompt", /A red square icon/.test(img?.revisedPrompt ?? ""));
  check("a preview image is attached", one.images.length === 1 && one.images[0].mimeType === "image/jpeg");
  check("the preview is real image data", Buffer.from(one.images[0].data, "base64").subarray(0, 2).toString("hex") === "ffd8");
  check("the empty data-URI noise is stripped from the summary", !/data:image/.test(one.data.summary), one.data.summary);

  const again = await call("codex_generate_image", { prompt: "A red square icon", workingDirectory: out, preview: "none", waitSeconds: 20 });
  check("never overwrites: a second run gets a suffix", again.data.images?.[0]?.path.endsWith("a-red-square-icon-2.png"), again.data.images?.[0]?.path);
  check('preview "none" attaches nothing', again.images.length === 0);

  const many = await call("codex_generate_image", {
    prompt: "Three variants", workingDirectory: out, count: 3, outputPath: "variants/logo.png", waitSeconds: 20,
  });
  check("count produces that many images", many.data.images?.length === 3, String(many.data.images?.length));
  check("numbered from the given file name", many.data.images?.map((i) => path.basename(i.path)).join(",") === "logo-1.png,logo-2.png,logo-3.png",
    many.data.images?.map((i) => path.basename(i.path)).join(","));
  check("one preview per image", many.images.length === 3);

  const jpg = await call("codex_generate_image", { prompt: "Photo", workingDirectory: out, outputPath: "photo.jpg", waitSeconds: 20 });
  const jpgPath = jpg.data.images?.[0]?.path;
  check("a .jpg output path is transcoded, not mislabelled", jpgPath && fs.readFileSync(jpgPath).subarray(0, 2).toString("hex") === "ffd8");
  check("and reported as JPEG", jpg.data.images?.[0]?.mimeType === "image/jpeg");

  const ref = await call("codex_generate_image", {
    prompt: "Edit it", workingDirectory: out, referenceImages: [img.path], waitSeconds: 20,
  });
  check("reference images are passed to Codex", /\[refs=1\]/.test(ref.data.images?.[0]?.revisedPrompt ?? ""), ref.data.images?.[0]?.revisedPrompt);

  const badRef = await call("codex_generate_image", { prompt: "x", workingDirectory: out, referenceImages: ["nope.png"] });
  check("a missing reference image is rejected up front", badRef.isError === true);

  const astra = await call("codex_generate_image", { prompt: "Hard one", workingDirectory: out, model: "astra", reasoningEffort: "max", waitSeconds: 20 });
  check("model and effort can be overridden, still capped", astra.data.model === "gpt-6-astra" && astra.data.reasoningEffort === "high",
    `${astra.data.model}/${astra.data.reasoningEffort}`);
});

console.log("");
console.log("unrequested transparency is flagged, and the preview shows it");
await withServer("image_alpha", {}, async (call) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-img-"));
  const { data, images } = await call("codex_generate_image", { prompt: "An icon", workingDirectory: out, waitSeconds: 20 });
  check("still completes — the image exists", data.status === "completed", data.status);
  check("reports how transparent it is", data.images?.[0]?.transparentPercent === 100, String(data.images?.[0]?.transparentPercent));
  check("warns that nobody asked for transparency", /unrequested transparency/.test(data.warning ?? ""), data.warning);
  check("the file itself is left untouched", fs.readFileSync(data.images[0].path)[25] === 6); // still RGBA

  // A near-invisible image over a checkerboard must show the checkerboard, not
  // flat white — otherwise the preview hides exactly the defect it should reveal.
  const decoded = jpeg.decode(Buffer.from(images[0].data, "base64"), { useTArray: true });
  const px = (x, y) => decoded.data[(y * decoded.width + x) * 4 + 1]; // green channel
  check(
    "the preview draws transparency as a checkerboard",
    Math.abs(px(3, 3) - px(15, 3)) > 25,
    `cell A=${px(3, 3)} cell B=${px(15, 3)}`,
  );

  const wanted = await call("codex_generate_image", {
    prompt: "An icon", workingDirectory: out, transparentBackground: true, waitSeconds: 20,
  });
  check("no warning when transparency was asked for", !wanted.data.warning, wanted.data.warning);
});

console.log("");
console.log("image quota and failures");
await withServer("image_quota", {}, async (call) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-img-"));
  const { data, images } = await call("codex_generate_image", { prompt: "Anything", workingDirectory: out, waitSeconds: 20 });
  check("an exhausted image quota is quota_exhausted", data.status === "quota_exhausted", data.status);
  check("with the reset time", /2026|20\d\d-/.test(data.summary ?? ""), data.summary);
  check("and no pretence that Claude can finish it", /cannot generate images yourself/.test(data.nextStep ?? ""), data.nextStep);
  check("no preview for an image that does not exist", images.length === 0);
});
await withServer("image_none", {}, async (call) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-img-"));
  const { data } = await call("codex_generate_image", { prompt: "Anything", workingDirectory: out, waitSeconds: 20 });
  check("a turn with no image is a failure, not a success", data.status === "failed", data.status);
  check("with a usable next step", /Rephrase/.test(data.nextStep ?? ""), data.nextStep);
});

// ================================================================ state file

// ================================================================ review findings

console.log("");
console.log("a late start reply cannot hijack the next turn");
await withServer(
  "slow",
  { ...FAST_WATCHDOG, FAKE_START_REPLY_DELAY_MS: "4000", FAKE_NO_TURN_STARTED: "1" },
  async (call) => {
    // A's start reply is held back for 4s and no turn/started is sent, so the
    // router only learns A's id through thread/read.
    const a = await call("codex_delegate", { task: "Turn A", workingDirectory: cwd, waitSeconds: 1 });
    const stopA = await call("codex_interrupt", { taskId: a.data.taskId });
    check("A is interrupted before its start reply arrives", stopA.data.status === "interrupted", stopA.data.status);
    check("and Codex confirmed it", stopA.data.forced === false, String(stopA.data.forced));

    const b = await call("codex_continue", { taskId: a.data.taskId, instruction: "Turn B", waitSeconds: 1 });
    check("B runs on the same thread", b.data.status === "running", b.data.status);
    await sleep(2300); // A's stale reply lands now; B's own reply is still pending

    const stopB = await call("codex_interrupt", { taskId: a.data.taskId });
    check("interrupting B reaches B itself", stopB.data.status === "interrupted" && stopB.data.forced === false,
      `${stopB.data.status} forced=${stopB.data.forced}`);
    check(
      "B is not settled with A's stale outcome",
      !(stopB.data.interventions ?? []).some((i) => i.action === "reconciled"),
      JSON.stringify(stopB.data.interventions),
    );
  },
);

console.log("");
console.log("concurrent image generations never overwrite each other");
await withServer("image", {}, async (call) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-img-"));
  const args = { prompt: "Same file", workingDirectory: out, outputPath: "same.png", preview: "none", waitSeconds: 20 };
  const [x, y] = await Promise.all([call("codex_generate_image", args), call("codex_generate_image", args)]);
  const px = x.data.images?.[0]?.path;
  const py = y.data.images?.[0]?.path;
  check("both complete", x.data.status === "completed" && y.data.status === "completed");
  check("they get different files", px && py && px !== py, `${px} / ${py}`);
  check("both files exist", px && py && fs.existsSync(px) && fs.existsSync(py));
  check("and the planned name went to exactly one", [px, py].filter((p) => p?.endsWith("same.png")).length === 1);
});

console.log("");
console.log("an image follow-up is judged on its own turn");
await withServer("image_then_quota", {}, async (call) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-img-"));
  const first = await call("codex_generate_image", { prompt: "First", workingDirectory: out, preview: "none", waitSeconds: 20 });
  check("the first turn succeeds", first.data.status === "completed", first.data.status);
  const next = await call("codex_continue", { taskId: first.data.taskId, instruction: "Another variant", waitSeconds: 20 });
  check(
    "a follow-up that hits the image quota is quota_exhausted, not completed",
    next.data.status === "quota_exhausted",
    next.data.status,
  );
  check("the earlier image is still recorded", next.data.images?.length === 1);
});

console.log("");
console.log("model policy edge cases");
await withServer("success", { AGENT_ROUTER_DEFAULT_MODEL: "gpt-9-not-rolled-out" }, async (call) => {
  const d = await call("codex_delegate", { task: "x", workingDirectory: cwd, reasoningEffort: "max", waitSeconds: 20 });
  check("an unavailable default falls back to the account default", d.data.model === "gpt-6-sol", d.data.model);
  check("whose policy cap still applies", d.data.reasoningEffort === "high", d.data.reasoningEffort);
  check("and the fallback is explained", (d.data.notes ?? []).some((n) => /not available/.test(n)));
});
await withServer("success", { AGENT_ROUTER_DEFAULT_MODEL: "gpt-5.5" }, async (call) => {
  const m = await call("codex_get_models");
  check("an off-policy default is advertised as the default", m.data.defaultModel === "gpt-5.5", m.data.defaultModel);
  const d = await call("codex_delegate", { task: "x", workingDirectory: cwd, waitSeconds: 20 });
  check("and is what an omitted model actually uses", d.data.model === "gpt-5.5", d.data.model);
});

console.log("");
console.log("files written through the shell are still reported");
await withServer("shell_write", {}, async (call) => {
  const repo = makeRepo();
  const { data } = await call("codex_delegate", { task: "Write shell.txt", workingDirectory: repo.dir, waitSeconds: 20 });
  check("the file really is on disk", fs.existsSync(path.join(repo.dir, "shell.txt")));
  check(
    "changedFiles includes it although Codex reported no change",
    data.changedFiles.includes("shell.txt (add)"),
    JSON.stringify(data.changedFiles),
  );
  check("the source is the working tree, not Codex's own list", data.changeSource === "working-tree", data.changeSource);
  check("the diff shows it", /shell\.txt/.test(data.diff ?? ""));
  check("no false claim that nothing was written", !/could not write any files/.test(data.warning ?? ""), data.warning);
  check("no warning at all — the rejected patch was superseded", !data.warning, data.warning);

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-plain-"));
  const outside = await call("codex_delegate", { task: "Write shell.txt", workingDirectory: plain, waitSeconds: 20 });
  check("outside git the source is Codex's own list", outside.data.changeSource === "codex-reported", outside.data.changeSource);
  check(
    "and the warning admits it cannot verify, instead of claiming nothing was written",
    /cannot tell whether/.test(outside.data.warning ?? "") && !/Nothing changed on disk/.test(outside.data.warning ?? ""),
    outside.data.warning,
  );
});

console.log("");
console.log("state survives a router restart");
{
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-state-"));
  const stateFile = path.join(stateDir, "tasks.json");
  let taskId;
  await withServer("slow", { AGENT_ROUTER_STATE_FILE: stateFile }, async (call) => {
    const { data } = await call("codex_delegate", { task: "Interrupted by restart", workingDirectory: cwd, waitSeconds: 1 });
    taskId = data.taskId;
    await sleep(400); // let the debounced write land
  });
  check("the state file is written atomically (no .tmp left behind)", fs.existsSync(stateFile) && !fs.existsSync(`${stateFile}.tmp`));
  await withServer("success", { AGENT_ROUTER_STATE_FILE: stateFile }, async (call) => {
    const { data } = await call("codex_task_status", { taskId });
    check("a task running when the router died comes back interrupted", data.status === "interrupted", data.status);
    check("with the reason recorded", (data.interventions ?? []).some((i) => i.action === "app-server-restarted"));
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
