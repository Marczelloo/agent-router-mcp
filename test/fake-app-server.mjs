#!/usr/bin/env node
/**
 * A stand-in for `codex app-server` that speaks just enough of the protocol to
 * exercise the router without burning real Codex quota.
 *
 * Scenario is chosen with FAKE_SCENARIO:
 *   success | quota_midturn | slow | fail | write_blocked
 */
import readline from "node:readline";

const scenario = process.env.FAKE_SCENARIO ?? "success";
// Real Codex hands out a fresh thread id per thread/start; the fake must too,
// or two tasks would collide in the router's thread -> task map.
let threadSeq = 0;
const TURN_ID = "turn-fake-0001";

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

const healthyLimits = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1788029116 },
    // Deliberately weekly-in-primary-order-reversed: the 5h window sits in
    // `secondary` here so the test proves labels come from the duration.
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
/** Echoed back in the review output so tests can assert the target mapping. */
let lastReviewTarget = null;
let lastThreadStart = null;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification from the client

  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        userAgent: "fake-app-server/0.0.0",
        codexHome: "/tmp/fake-codex",
        platformFamily: "test",
        platformOs: "test",
      });
      return;

    case "model/list":
      reply(msg.id, {
        data: [
          {
            id: "fake-large",
            model: "fake-large",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "Fake Large",
            description: "Frontier fake model.",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "fast" },
              { reasoningEffort: "high", description: "deep" },
            ],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
          },
          {
            id: "fake-small",
            model: "fake-small",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "Fake Small",
            description: "Cheap fake model.",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
            supportsPersonality: false,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: false,
          },
        ],
        nextCursor: null,
      });
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
        model: msg.params?.model ?? "fake-large",
        modelProvider: "openai",
        serviceTier: null,
        cwd: msg.params?.cwd ?? "/tmp",
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite" },
        reasoningEffort: "low",
      });
      return;
    }

    case "turn/start":
      reply(msg.id, {
        turn: { id: TURN_ID, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 0, completedAt: null, durationMs: null },
      });
      runTurn(msg.params.threadId);
      return;

    case "review/start":
      lastReviewTarget = msg.params?.target ?? null;
      reply(msg.id, {
        turn: { id: TURN_ID, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 0, completedAt: null, durationMs: null },
        reviewThreadId: msg.params.threadId,
      });
      runReview(msg.params.threadId);
      return;

    case "turn/interrupt":
      notify("turn/completed", {
        threadId: msg.params.threadId,
        turn: { id: TURN_ID, items: [], status: "interrupted", error: null, startedAt: 0, completedAt: 1, durationMs: 1 },
      });
      reply(msg.id, {});
      return;

    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `fake: ${msg.method}` } });
  }
});

function runTurn(THREAD_ID) {
  setTimeout(() => {
    notify("turn/started", {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, items: [], status: "inProgress", error: null, startedAt: 0, completedAt: null, durationMs: null },
    });

    if (scenario === "slow") return; // never completes

    if (scenario === "quota_midturn") {
      setTimeout(() => {
        notify("error", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          willRetry: false,
          error: {
            message: "You've hit your usage limit.",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          },
        });
      }, 50);
      return;
    }

    if (scenario === "write_blocked") {
      // Codex finishes the turn cleanly, but the sandbox rejected every patch.
      setTimeout(() => {
        notify("item/completed", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          completedAtMs: 1,
          item: {
            type: "fileChange",
            id: "f1",
            status: "failed",
            changes: [{ path: "greeting.txt", kind: { type: "add" }, diff: "+hello" }],
          },
        });
        notify("item/completed", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          completedAtMs: 2,
          item: { type: "agentMessage", id: "f2", text: "I could not write the file." },
        });
        notify("turn/completed", {
          threadId: THREAD_ID,
          turn: { id: TURN_ID, items: [], status: "completed", error: null, startedAt: 0, completedAt: 1, durationMs: 900 },
        });
      }, 40);
      return;
    }

    if (scenario === "fail") {
      setTimeout(() => {
        notify("turn/completed", {
          threadId: THREAD_ID,
          turn: {
            id: TURN_ID,
            items: [],
            status: "failed",
            error: { message: "compile error", codexErrorInfo: "other", additionalDetails: null },
            startedAt: 0,
            completedAt: 1,
            durationMs: 1000,
          },
        });
      }, 50);
      return;
    }

    // success
    notify("turn/plan/updated", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      explanation: null,
      plan: [
        { step: "write hello.txt", status: "completed" },
        { step: "verify", status: "completed" },
      ],
    });
    notify("item/completed", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: 1,
      item: { type: "commandExecution", id: "i1", command: "cat hello.txt", status: "completed" },
    });
    notify("item/completed", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: 2,
      item: {
        type: "fileChange",
        id: "i2",
        status: "completed",
        changes: [{ path: "hello.txt", kind: { type: "add" }, diff: "+hello from codex" }],
      },
    });
    notify("turn/diff/updated", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      diff:
        "diff --git a/hello.txt b/hello.txt\n--- /dev/null\n+++ b/hello.txt\n@@\n+hello from codex\n",
    });
    notify("item/completed", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: 3,
      item: { type: "agentMessage", id: "i3", text: "Created hello.txt with the requested text." },
    });
    notify("turn/completed", {
      threadId: THREAD_ID,
      turn: {
        id: TURN_ID,
        items: [],
        status: "completed",
        error: null,
        startedAt: 0,
        completedAt: 1,
        durationMs: 1200,
      },
    });
  }, 30);
}

function runReview(THREAD_ID) {
  setTimeout(() => {
    notify("turn/started", {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, items: [], status: "inProgress", error: null, startedAt: 0, completedAt: null, durationMs: null },
    });
    notify("item/completed", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: 1,
      item: { type: "enteredReviewMode", id: "r0", review: "start" },
    });
    notify("item/completed", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: 2,
      item: {
        type: "agentMessage",
        id: "r1",
        text: [
          "REVIEW FINDINGS",
          `target=${JSON.stringify(lastReviewTarget)}`,
          `sandbox=${JSON.stringify(lastThreadStart?.sandbox ?? null)}`,
          `instructions=${JSON.stringify(lastThreadStart?.developerInstructions ?? "")}`,
        ].join(" | "),
      },
    });
    notify("item/completed", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: 3,
      item: { type: "exitedReviewMode", id: "r2", review: "done" },
    });
    notify("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, items: [], status: "completed", error: null, startedAt: 0, completedAt: 1, durationMs: 500 },
    });
  }, 30);
}
