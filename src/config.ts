import path from "node:path";
import os from "node:os";

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

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  /** Executable used to launch the persistent app-server child process. */
  codexBin: process.env.AGENT_ROUTER_CODEX_BIN ?? "codex",
  codexArgs: parseArgs(process.env.AGENT_ROUTER_CODEX_ARGS ?? "app-server"),

  /** Sandbox/approval defaults for delegated Codex threads. */
  sandbox: (process.env.AGENT_ROUTER_SANDBOX ?? "workspace-write") as
    | "read-only"
    | "workspace-write"
    | "danger-full-access",
  approvalPolicy: (process.env.AGENT_ROUTER_APPROVAL_POLICY ?? "never") as
    | "untrusted"
    | "on-request"
    | "never",
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
  quotaLowRemainingPercent: num("AGENT_ROUTER_QUOTA_LOW_PERCENT", 15),
  quotaBlockRemainingPercent: num("AGENT_ROUTER_QUOTA_BLOCK_PERCENT", 2),

  /** How long a delegate/continue call blocks before handing back a pollable taskId. */
  defaultWaitSeconds: num("AGENT_ROUTER_DEFAULT_WAIT_SECONDS", 240),
  maxWaitSeconds: num("AGENT_ROUTER_MAX_WAIT_SECONDS", 1800),

  /** Startup handshake budget for the child process. */
  startupTimeoutMs: num("AGENT_ROUTER_STARTUP_TIMEOUT_MS", 30_000),
  requestTimeoutMs: num("AGENT_ROUTER_REQUEST_TIMEOUT_MS", 120_000),

  /**
   * Default isolation for delegated work. "worktree" runs Codex in a dedicated
   * git worktree on its own branch, so a bad turn cannot touch the user's tree.
   */
  defaultIsolation: (process.env.AGENT_ROUTER_ISOLATION ?? "none") as "none" | "worktree",
  /** Where linked worktrees are created — deliberately outside the repository. */
  worktreeRoot:
    process.env.AGENT_ROUTER_WORKTREE_ROOT ??
    path.join(os.homedir(), ".agent-router", "worktrees"),
  /** Snapshot the working tree before and after every turn. */
  checkpoints: process.env.AGENT_ROUTER_CHECKPOINTS !== "off",

  /** Best-effort task metadata persistence. */
  stateFile:
    process.env.AGENT_ROUTER_STATE_FILE ??
    path.join(os.homedir(), ".agent-router", "tasks.json"),

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
