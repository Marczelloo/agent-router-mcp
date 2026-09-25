#!/usr/bin/env node
/**
 * A stand-in for `codex app-server` that speaks just enough of the protocol to
 * exercise the router without burning real Codex quota.
 *
 * Scenario is chosen with FAKE_SCENARIO:
 *   success         turn completes with a plan, a command, a file change and a message
 *   quota_midturn   turn dies with usageLimitExceeded
 *   fail            turn fails with a non-quota error
 *   write_blocked   turn completes but every patch was rejected
 *   shell_write     a patch is rejected, then the file is written by a shell command
 *   slow            turn never completes; turn/interrupt is honoured
 *   slow_complete   turn completes 2.5s later, after the caller stopped waiting
 *   lost_completion turn/completed is never sent, but thread/read knows it finished
 *   unresponsive    turn never completes and turn/interrupt is ignored
 *   blocked         turn waits on an approval nobody can give
 *   image           image generation succeeds (one image per requested count)
 *   image_alpha     image generation returns a mostly transparent RGBA image
 *   image_quota     image generation hits its own usage limit
 *   image_then_quota the first image turn on a thread succeeds, later ones hit the limit
 *
 * Knobs: FAKE_START_REPLY_DELAY_MS delays every turn/start reply;
 * FAKE_NO_TURN_STARTED suppresses the turn/started event.
 *   image_none      turn completes without producing an image
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { PNG } from "pngjs";

const scenario = process.env.FAKE_SCENARIO ?? "success";

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

// ---------------------------------------------------------------- state

// Real Codex hands out a fresh id per thread and per turn; the fake must too, or
// two tasks (or two turns of one task) would collide in the router's bookkeeping.
let threadSeq = 0;
let turnSeq = 0;
const threads = new Map(); // threadId -> { status, turns: [turn] }

function newTurn() {
  return {
    id: `turn-fake-${String(++turnSeq).padStart(4, "0")}`,
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 0,
    completedAt: null,
    durationMs: null,
  };
}

function setThreadStatus(threadId, status) {
  const thread = threads.get(threadId);
  if (thread) thread.status = status;
  notify("thread/status/changed", { threadId, status });
}

function completeTurn(threadId, turn, status, error = null, quiet = false) {
  turn.status = status;
  turn.error = error;
  turn.completedAt = 1;
  if (!quiet) notify("turn/completed", { threadId, turn: { ...turn, items: [] } });
  setThreadStatus(threadId, { type: "idle" });
}

// ---------------------------------------------------------------- catalogue

const efforts = (...names) => names.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));
const model = (id, isDefault, supported) => ({
  id,
  model: id,
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: id,
  description: `${id} (fake)`,
  hidden: false,
  supportedReasoningEfforts: supported,
  defaultReasoningEffort: "medium",
  inputModalities: ["text", "image"],
  supportsPersonality: false,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  isDefault,
});

// Mirrors the real catalogue shape: the three policy models plus one outside it.
const CATALOGUE = [
  model("gpt-6-astra", false, efforts("low", "medium", "high", "xhigh", "max", "ultra")),
  model("gpt-6-sol", true, efforts("low", "medium", "high", "xhigh", "max", "ultra")),
  model("gpt-6-luna", false, efforts("low", "medium", "high", "xhigh", "max")),
  model("gpt-5.5", false, efforts("low", "medium", "high", "xhigh")),
];

const healthyLimits = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1788029116 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1788459662 },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: { availableCount: 0, credits: [] },
};

const exhaustedLimits = JSON.parse(JSON.stringify(healthyLimits));
exhaustedLimits.rateLimits.primary.usedPercent = 100;
exhaustedLimits.rateLimits.rateLimitReachedType = "rate_limit_reached";

let limitsRead = 0;
/** Echoed back in review output so tests can assert the target mapping. */
let lastReviewTarget = null;
let lastThreadStart = null;

/** A small real PNG, so the router's decoding and preview paths run for real. */
function fakePng(width, height, rgb, alpha = 255) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = alpha;
  }
  return PNG.sync.write(png).toString("base64");
}

// ---------------------------------------------------------------- requests

// FAKE_STRICT_INIT enforces the handshake the protocol specifies: nothing but
// `initialize` is served until the client has sent `initialized`. Current Codex
// is lenient about it, but a client must not rely on that.
const strictInit = Boolean(process.env.FAKE_STRICT_INIT);
const initDelayMs = Number(process.env.FAKE_INIT_DELAY_MS ?? 0);
let initialized = false;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) {
    // notification from the client
    if (msg.method === "initialized") initialized = true;
    return;
  }
  // Server -> client request replies (approvals) arrive with a result; ignore.
  if (msg.method === undefined) return;

  if (strictInit && !initialized && msg.method !== "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "Not initialized" } });
    return;
  }

  switch (msg.method) {
    case "initialize":
      // FAKE_INIT_FAIL_ONCE=<marker file>: the first process to start fails its
      // handshake; the next one (after the marker exists) succeeds.
      if (process.env.FAKE_INIT_FAIL_ONCE && !fs.existsSync(process.env.FAKE_INIT_FAIL_ONCE)) {
        fs.writeFileSync(process.env.FAKE_INIT_FAIL_ONCE, "failed once");
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "initialize exploded" } });
        return;
      }
      setTimeout(
        () =>
          reply(msg.id, {
            userAgent: "fake-app-server/0.155.1 (test)",
            codexHome: "/tmp/fake-codex",
            platformFamily: "test",
            platformOs: "test",
          }),
        initDelayMs,
      );
      return;

    case "model/list":
      reply(msg.id, { data: CATALOGUE, nextCursor: null });
      return;

    case "account/rateLimits/read": {
      limitsRead += 1;
      // In the mid-turn quota scenario the second read (the one taken while
      // building the handoff) reports the account as exhausted.
      const payload =
        scenario === "quota_midturn" && limitsRead > 1 ? exhaustedLimits : healthyLimits;
      reply(msg.id, payload);
      return;
    }

    case "thread/start":
    case "thread/resume": {
      if (msg.method === "thread/start") lastThreadStart = msg.params ?? {};
      const threadId =
        msg.method === "thread/resume"
          ? msg.params.threadId
          : `thread-fake-${String(++threadSeq).padStart(4, "0")}`;
      if (!threads.has(threadId)) threads.set(threadId, { status: { type: "idle" }, turns: [] });
      reply(msg.id, {
        thread: {
          id: threadId,
          sessionId: "session-fake",
          forkedFromId: null,
          parentThreadId: null,
          preview: "",
          ephemeral: false,
          isPinned: false,
          modelProvider: "openai",
          createdAt: 0,
          updatedAt: 0,
        },
        model: msg.params?.model ?? "gpt-6-sol",
        modelProvider: "openai",
        serviceTier: null,
        cwd: msg.params?.cwd ?? "/tmp",
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite" },
        reasoningEffort: "medium",
      });
      return;
    }

    case "thread/read": {
      const thread = threads.get(msg.params.threadId);
      if (!thread) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "thread not found" } });
        return;
      }
      reply(msg.id, {
        thread: {
          id: msg.params.threadId,
          status: thread.status,
          turns: thread.turns.map((t) => ({ ...t, items: [] })),
        },
      });
      return;
    }

    case "turn/start": {
      const threadId = msg.params.threadId;
      const turn = newTurn();
      threads.get(threadId)?.turns.push(turn);
      // FAKE_START_REPLY_DELAY_MS reproduces a start reply that arrives after
      // the turn has already been settled and a newer one begun.
      const replyDelay = Number(process.env.FAKE_START_REPLY_DELAY_MS ?? 0);
      const answer = () => reply(msg.id, { turn: { ...turn } });
      if (replyDelay > 0) setTimeout(answer, replyDelay);
      else answer();
      runTurn(threadId, turn, msg.params);
      return;
    }

    case "review/start": {
      lastReviewTarget = msg.params?.target ?? null;
      const threadId = msg.params.threadId;
      const turn = newTurn();
      threads.get(threadId)?.turns.push(turn);
      reply(msg.id, { turn: { ...turn }, reviewThreadId: threadId });
      runReview(threadId, turn);
      return;
    }

    case "turn/interrupt": {
      const thread = threads.get(msg.params.threadId);
      const turn = thread?.turns.find((t) => t.id === msg.params.turnId);
      reply(msg.id, {});
      // An unresponsive server acknowledges the request and then does nothing.
      if (scenario !== "unresponsive" && turn && turn.status === "inProgress") {
        completeTurn(msg.params.threadId, turn, "interrupted");
      }
      return;
    }

    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `fake: ${msg.method}` } });
  }
});

// ---------------------------------------------------------------- turns

function item(threadId, turn, payload, at = 1) {
  notify("item/completed", { threadId, turnId: turn.id, completedAtMs: at, item: payload });
}

function runTurn(threadId, turn, params) {
  setTimeout(() => {
    setThreadStatus(threadId, { type: "active", activeFlags: [] });
    // FAKE_NO_TURN_STARTED drops the event, so the router knows no turn id
    // except through the start reply or thread/read.
    if (!process.env.FAKE_NO_TURN_STARTED) notify("turn/started", { threadId, turn: { ...turn } });

    switch (scenario) {
      case "slow":
      case "unresponsive":
        return; // never completes on its own

      case "lost_completion":
        // Codex finished, but the completion notification never made it.
        setTimeout(() => {
          item(threadId, turn, { type: "agentMessage", id: "l1", text: "Done, quietly." });
          completeTurn(threadId, turn, "completed", null, true);
        }, 50);
        return;

      case "blocked":
        setThreadStatus(threadId, { type: "active", activeFlags: ["waitingOnApproval"] });
        return;

      case "slow_complete":
        // Finishes, but only after the caller has stopped waiting — the case
        // that used to leave a task stuck in "running" forever.
        setTimeout(() => {
          item(threadId, turn, { type: "agentMessage", id: "s1", text: "Finished the long task." });
          completeTurn(threadId, turn, "completed");
        }, 2500);
        return;

      case "quota_midturn":
        setTimeout(() => {
          notify("error", {
            threadId,
            turnId: turn.id,
            willRetry: false,
            error: {
              message: "You've hit your usage limit.",
              codexErrorInfo: "usageLimitExceeded",
              additionalDetails: null,
            },
          });
        }, 50);
        return;

      case "fail":
        setTimeout(
          () =>
            completeTurn(threadId, turn, "failed", {
              message: "compile error",
              codexErrorInfo: "other",
              additionalDetails: null,
            }),
          50,
        );
        return;

      case "write_blocked":
        // Codex finishes the turn cleanly, but the sandbox rejected every patch.
        setTimeout(() => {
          item(threadId, turn, {
            type: "fileChange",
            id: "f1",
            status: "failed",
            changes: [{ path: "greeting.txt", kind: { type: "add" }, diff: "+hello" }],
          });
          item(threadId, turn, { type: "agentMessage", id: "f2", text: "I could not write the file." }, 2);
          completeTurn(threadId, turn, "completed");
        }, 40);
        return;

      case "shell_write":
        // The patch tool is refused, then the file is written by a shell
        // command — which, as in real Codex, produces no change event at all.
        setTimeout(() => {
          item(threadId, turn, {
            type: "fileChange",
            id: "p1",
            status: "failed",
            changes: [{ path: "shell.txt", kind: { type: "add" }, diff: "+x" }],
          });
          fs.writeFileSync(path.join(params.cwd, "shell.txt"), "written by a shell command");
          item(threadId, turn, { type: "commandExecution", id: "c1", command: "Set-Content shell.txt", status: "completed" }, 2);
          item(threadId, turn, { type: "agentMessage", id: "m1", text: "Wrote shell.txt." }, 3);
          completeTurn(threadId, turn, "completed");
        }, 40);
        return;

      case "image":
      case "image_alpha":
      case "image_quota":
      case "image_then_quota":
      case "image_none":
        setTimeout(() => runImages(threadId, turn, params), 40);
        return;

      default:
        break;
    }

    // success
    notify("turn/plan/updated", {
      threadId,
      turnId: turn.id,
      explanation: null,
      plan: [
        { step: "write hello.txt", status: "completed" },
        { step: "verify", status: "completed" },
      ],
    });
    item(threadId, turn, { type: "commandExecution", id: "i1", command: "cat hello.txt", status: "completed" });
    item(
      threadId,
      turn,
      {
        type: "fileChange",
        id: "i2",
        status: "completed",
        changes: [{ path: "hello.txt", kind: { type: "add" }, diff: "+hello from codex" }],
      },
      2,
    );
    notify("turn/diff/updated", {
      threadId,
      turnId: turn.id,
      diff: "diff --git a/hello.txt b/hello.txt\n--- /dev/null\n+++ b/hello.txt\n@@\n+hello from codex\n",
    });
    item(threadId, turn, { type: "agentMessage", id: "i3", text: "Created hello.txt with the requested text." }, 3);
    completeTurn(threadId, turn, "completed");
  }, 30);
}

const imageTurns = new Map(); // threadId -> image turns run so far

function runImages(threadId, turn, params) {
  const text = params?.input?.find((i) => i.type === "text")?.text ?? "";
  const references = (params?.input ?? []).filter((i) => i.type === "localImage").length;
  const requested = Number(/Generate (\d+) separate images/.exec(text)?.[1] ?? 1);
  const turnNumber = (imageTurns.get(threadId) ?? 0) + 1;
  imageTurns.set(threadId, turnNumber);
  // image_then_quota: the first turn on a thread succeeds, later ones hit the limit.
  const outOfQuota = scenario === "image_quota" || (scenario === "image_then_quota" && turnNumber > 1);

  if (scenario === "image_none") {
    item(threadId, turn, { type: "agentMessage", id: "n1", text: "I cannot draw that." });
    completeTurn(threadId, turn, "completed");
    return;
  }

  for (let n = 1; n <= requested; n++) {
    const id = `img-${turn.id}-${n}`;
    notify("item/started", {
      threadId,
      turnId: turn.id,
      item: { type: "imageGeneration", id, status: "in_progress", revisedPrompt: null, result: "", failure: null },
    });
    if (outOfQuota) {
      item(threadId, turn, {
        type: "imageGeneration",
        id,
        status: "failed",
        revisedPrompt: null,
        result: "",
        failure: { type: "usageLimitExceeded", limitId: "images", resetsAt: 1790124213 },
      });
      break;
    }
    item(threadId, turn, {
      type: "imageGeneration",
      id,
      status: "completed",
      revisedPrompt: `${text.split("\n")[0]} [refs=${references}] [#${n}]`,
      // image_alpha reproduces a real Codex output: RGBA with a near-invisible alpha.
      result: fakePng(96, 64, [200, 30, 30], scenario === "image_alpha" ? 10 : 255),
      transparentBackground: false,
      failure: null,
    });
  }
  // Real Codex echoes an empty data URI; the router must strip it.
  item(threadId, turn, { type: "agentMessage", id: "m1", text: "Generated it.\n![](data:image/png;base64,)" }, 9);
  completeTurn(threadId, turn, "completed");
}

function runReview(threadId, turn) {
  setTimeout(() => {
    setThreadStatus(threadId, { type: "active", activeFlags: [] });
    notify("turn/started", { threadId, turn: { ...turn } });
    item(threadId, turn, { type: "enteredReviewMode", id: "r0", review: "start" });
    item(
      threadId,
      turn,
      {
        type: "agentMessage",
        id: "r1",
        text: [
          "REVIEW FINDINGS",
          `target=${JSON.stringify(lastReviewTarget)}`,
          `sandbox=${JSON.stringify(lastThreadStart?.sandbox ?? null)}`,
          `model=${JSON.stringify(lastThreadStart?.model ?? null)}`,
          `instructions=${JSON.stringify(lastThreadStart?.developerInstructions ?? "")}`,
        ].join(" | "),
      },
      2,
    );
    item(threadId, turn, { type: "exitedReviewMode", id: "r2", review: "done" }, 3);
    completeTurn(threadId, turn, "completed");
  }, 30);
}

