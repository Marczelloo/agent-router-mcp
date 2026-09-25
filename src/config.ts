import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** The package version, read once so it is stated in exactly one place. */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * Args come either as a whitespace-separated string ("app-server") or, when a
 * path contains spaces, as a JSON array ('["C:/some dir/server.mjs"]').
 */
function parseArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through to whitespace splitting
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * A misconfigured value fails the server at startup, loudly, rather than being
 * cast through: `AGENT_ROUTER_ISOLATION=worktrees` would otherwise silently edit
 * the user's tree in place, and a timer beyond 2^31 ms fires after 1 ms.
 */
function invalid(name: string, raw: string, expected: string): never {
  throw new Error(`Invalid ${name}=${JSON.stringify(raw)}: expected ${expected}.`);
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    invalid(name, raw, `a number from ${min} to ${max}`);
  }
  return parsed;
}

function oneOf<const T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim() as T;
  if (!allowed.includes(value)) invalid(name, raw, `one of ${allowed.join(", ")}`);
  return value;
}

/** Largest delay setTimeout honours; anything above it overflows to ~1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const DAY_SECONDS = 86_400;

export const config = {
  /** Executable used to launch the persistent app-server child process. */
  codexBin: process.env.AGENT_ROUTER_CODEX_BIN ?? "codex",
  codexArgs: parseArgs(process.env.AGENT_ROUTER_CODEX_ARGS ?? "app-server"),

  /** Sandbox/approval defaults for delegated Codex threads. */
  sandbox: oneOf("AGENT_ROUTER_SANDBOX", "workspace-write", [
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]),
  approvalPolicy: oneOf("AGENT_ROUTER_APPROVAL_POLICY", "never", ["untrusted", "on-request", "never"]),
  /**
   * Codex runs headless here, so nobody can answer an approval prompt. When it
   * asks anyway we decline by default rather than silently widening the sandbox.
   */
  autoApprove: process.env.AGENT_ROUTER_AUTO_APPROVE === "true",

  /**
   * Quota preflight. Set to "off" only when the limits endpoint misreports for
   * an account (for example a workspace billed outside the metered buckets);
   * Codex then decides for itself and we fall back to the mid-task handoff.
   */
  preflight: process.env.AGENT_ROUTER_QUOTA_PREFLIGHT !== "off",

  /** Quota policy thresholds, in remaining percent of the tightest window. */
  quotaLowRemainingPercent: num("AGENT_ROUTER_QUOTA_LOW_PERCENT", 15, 0, 100),
  quotaBlockRemainingPercent: num("AGENT_ROUTER_QUOTA_BLOCK_PERCENT", 2, 0, 100),

  /**
   * How long a call blocks before handing back a pollable taskId. Many MCP clients cancel a request after 60 s (the SDK default), so the
   * default stays under that. The task keeps running either way; callers wait
   * further with codex_task_status. Raise it only for clients that allow more.
   */
  defaultWaitSeconds: num("AGENT_ROUTER_DEFAULT_WAIT_SECONDS", 50, 1, DAY_SECONDS),
  maxWaitSeconds: num("AGENT_ROUTER_MAX_WAIT_SECONDS", 1800, 1, DAY_SECONDS),
  /** How often a blocked call sends an MCP progress notification. */
  progressIntervalSeconds: num("AGENT_ROUTER_PROGRESS_INTERVAL_SECONDS", 10, 0.1, 3600),

  /** Startup handshake budget for the child process. */
  startupTimeoutMs: num("AGENT_ROUTER_STARTUP_TIMEOUT_MS", 30_000, 1000, MAX_TIMER_MS),
  requestTimeoutMs: num("AGENT_ROUTER_REQUEST_TIMEOUT_MS", 120_000, 1000, MAX_TIMER_MS),

  /**
   * Default isolation for delegated work. "worktree" runs Codex in a dedicated
   * git worktree on its own branch, so a bad turn cannot touch the user's tree.
   */
  defaultIsolation: oneOf("AGENT_ROUTER_ISOLATION", "none", ["none", "worktree"]),
  /** Where linked worktrees are created — deliberately outside the repository. */
  worktreeRoot:
    process.env.AGENT_ROUTER_WORKTREE_ROOT ??
    path.join(os.homedir(), ".agent-router", "worktrees"),
  /** Snapshot the working tree before and after every turn. */
  checkpoints: process.env.AGENT_ROUTER_CHECKPOINTS !== "off",

  /** Model used when a caller names none. Aliases (luna, sol, astra) work too. */
  defaultModel: process.env.AGENT_ROUTER_DEFAULT_MODEL ?? "gpt-6-sol",

  /**
   * Turn watchdog. A turn is "stalled" after this long without any event from
   * Codex; the router then re-reads the thread to catch a lost completion. A
   * long silent command can legitimately trip it, so stalling alone never kills.
   */
  stallSeconds: num("AGENT_ROUTER_STALL_SECONDS", 180, 1, DAY_SECONDS),
  /**
   * How often activity kept only in memory (a long command streaming output)
   * refreshes the public status file, so readers do not see a live task as quiet.
   */
  statusHeartbeatMs: num("AGENT_ROUTER_STATUS_HEARTBEAT_MS", 10_000, 50, 10 * 60_000),
  /** Hard ceiling per turn; past it the router interrupts. 0 disables it. */
  turnTimeoutSeconds: num("AGENT_ROUTER_TURN_TIMEOUT_SECONDS", 3600, 0, 7 * DAY_SECONDS),
  /** How long a turn may wait on an approval or user input nobody can give. */
  blockedTimeoutSeconds: num("AGENT_ROUTER_BLOCKED_TIMEOUT_SECONDS", 60, 1, DAY_SECONDS),
  watchdogIntervalSeconds: num("AGENT_ROUTER_WATCHDOG_INTERVAL_SECONDS", 15, 0.1, 3600),
  /** How long codex_interrupt waits for Codex to confirm before forcing. */
  interruptGraceSeconds: num("AGENT_ROUTER_INTERRUPT_GRACE_SECONDS", 10, 0, 600),

  /** Image generation defaults: the cheapest model is plenty for a tool call. */
  imageModel: process.env.AGENT_ROUTER_IMAGE_MODEL ?? "gpt-6-luna",
  imageEffort: process.env.AGENT_ROUTER_IMAGE_EFFORT ?? "low",
  imagePreviewMaxEdge: num("AGENT_ROUTER_IMAGE_PREVIEW_MAX_EDGE", 768, 64, 4096),

  /** Best-effort task metadata persistence. */
  stateFile:
    process.env.AGENT_ROUTER_STATE_FILE ??
    path.join(os.homedir(), ".agent-router", "tasks.json"),

  /**
   * Small public snapshot of the tasks for other tools (e.g. Agent Pets), written
   * next to the state file unless set explicitly. See src/status.ts.
   */
  statusFile:
    process.env.AGENT_ROUTER_STATUS_FILE ??
    path.join(
      path.dirname(process.env.AGENT_ROUTER_STATE_FILE ?? path.join(os.homedir(), ".agent-router", "tasks.json")),
      "status.json",
    ),

  /** Set to "true" to mirror app-server stderr into this server's stderr. */
  debug: process.env.AGENT_ROUTER_DEBUG === "true",
};

export function log(...args: unknown[]): void {
  // stdout is the MCP transport — diagnostics must go to stderr.
  process.stderr.write(`[agent-router] ${args.map(String).join(" ")}\n`);
}

export function debugLog(...args: unknown[]): void {
  if (config.debug) log(...args);
}
