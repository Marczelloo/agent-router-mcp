import { config } from "./config.js";
import type {
  GetAccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from "./protocol.js";

export interface NormalizedWindow {
  /** Human label derived from the window duration, never from the slot name. */
  window: string;
  /** Which slot on the snapshot this came from — informational only. */
  slot: "primary" | "secondary";
  windowDurationMins: number | null;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  resetsAtEpoch: number | null;
  resetsInMinutes: number | null;
  rateLimitReached: boolean;
}

export interface NormalizedLimits {
  limitId: string | null;
  planType: string | null;
  /** Windows sorted shortest-first, labelled by duration. */
  windows: NormalizedWindow[];
  /** Convenience accessors; null when the account exposes no such window. */
  fiveHour: NormalizedWindow | null;
  weekly: NormalizedWindow | null;
  /** The window with the least remaining headroom — what actually gates a turn. */
  tightest: NormalizedWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  /** True when the backend itself reports the account as limited. */
  rateLimitReached: boolean;
  rateLimitReachedType: string | null;
  spendControlReached: boolean | null;
  resetCreditsAvailable: number;
  fetchedAt: string;
}

export type QuotaState = "ok" | "low" | "exhausted";

export interface QuotaVerdict {
  state: QuotaState;
  canDelegate: boolean;
  reason: string;
  /** Present when a window is what blocks us, so callers can report a reset time. */
  blockingWindow: NormalizedWindow | null;
}

/**
 * Label a rate-limit window by its declared duration.
 *
 * `primary`/`secondary` are slot names, not durations: the API is free to put the
 * weekly window in `primary`. Everything downstream keys off these labels.
 */
export function labelWindow(durationMins: number | null): string {
  if (durationMins == null) return "unknown";
  switch (durationMins) {
    case 60:
      return "1h";
    case 300:
      return "5h";
    case 1440:
      return "daily";
    case 10080:
      return "weekly";
    case 43200:
      return "monthly";
    default:
      break;
  }
  if (durationMins % 10080 === 0) return `${durationMins / 10080}w`;
  if (durationMins % 1440 === 0) return `${durationMins / 1440}d`;
  if (durationMins % 60 === 0) return `${durationMins / 60}h`;
  return `${durationMins}min`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return round(Math.min(100, Math.max(0, value)));
}

function normalizeWindow(
  slot: "primary" | "secondary",
  win: RateLimitWindow | null,
  now: number,
): NormalizedWindow | null {
  if (!win) return null;
  const used = clampPercent(win.usedPercent);
  const resetsAtEpoch = win.resetsAt ?? null;
  return {
    window: labelWindow(win.windowDurationMins),
    slot,
    windowDurationMins: win.windowDurationMins,
    usedPercent: used,
    remainingPercent: round(100 - used),
    resetsAt: resetsAtEpoch ? new Date(resetsAtEpoch * 1000).toISOString() : null,
    resetsAtEpoch,
    resetsInMinutes: resetsAtEpoch
      ? Math.max(0, Math.round((resetsAtEpoch * 1000 - now) / 60000))
      : null,
    rateLimitReached: used >= 100,
  };
}

export function normalizeLimits(response: GetAccountRateLimitsResponse): NormalizedLimits {
  // Prefer the metered `codex` bucket when the multi-bucket view is present.
  const snapshot: RateLimitSnapshot = response.rateLimitsByLimitId?.["codex"] ?? response.rateLimits;
  const now = Date.now();

  const windows = [
    normalizeWindow("primary", snapshot.primary, now),
    normalizeWindow("secondary", snapshot.secondary, now),
  ].filter((w): w is NormalizedWindow => w !== null);

  windows.sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity));

  const byLabel = (label: string) => windows.find((w) => w.window === label) ?? null;
  const tightest =
    windows.length === 0
      ? null
      : windows.reduce((min, w) => (w.remainingPercent < min.remainingPercent ? w : min));

  return {
    limitId: snapshot.limitId,
    planType: snapshot.planType,
    windows,
    fiveHour: byLabel("5h"),
    weekly: byLabel("weekly"),
    tightest,
    credits: snapshot.credits,
    rateLimitReached:
      snapshot.rateLimitReachedType != null || windows.some((w) => w.rateLimitReached),
    rateLimitReachedType: snapshot.rateLimitReachedType,
    spendControlReached: snapshot.spendControlReached,
    resetCreditsAvailable: response.rateLimitResetCredits?.availableCount ?? 0,
    fetchedAt: new Date(now).toISOString(),
  };
}

/**
 * Decide whether delegating to Codex is worth attempting.
 *
 * Credits (or an unlimited allowance) keep a maxed-out window from being fatal,
 * since Codex bills the overflow instead of refusing the turn.
 */
export function evaluateQuota(limits: NormalizedLimits): QuotaVerdict {
  const hasFallbackCredits = Boolean(limits.credits?.unlimited || limits.credits?.hasCredits);

  if (limits.spendControlReached) {
    return {
      state: "exhausted",
      canDelegate: false,
      reason: "Codex spend control limit reached for this account.",
      blockingWindow: null,
    };
  }

  const blocked = limits.windows
    .filter((w) => w.rateLimitReached || w.remainingPercent <= config.quotaBlockRemainingPercent)
    .sort((a, b) => a.remainingPercent - b.remainingPercent);

  if ((limits.rateLimitReached || blocked.length > 0) && !hasFallbackCredits) {
    const blockingWindow = blocked[0] ?? limits.tightest ?? null;
    const where = blockingWindow ? `${blockingWindow.window} window` : "account";
    const when = blockingWindow?.resetsAt ? ` Resets at ${blockingWindow.resetsAt}.` : "";
    return {
      state: "exhausted",
      canDelegate: false,
      reason: `Codex quota exhausted: ${where} at ${blockingWindow?.usedPercent ?? 100}% used.${when}`,
      blockingWindow,
    };
  }

  if (limits.rateLimitReached || blocked.length > 0) {
    return {
      state: "low",
      canDelegate: true,
      reason:
        "Codex rate limit reached but credits are available; the turn will consume credits instead of quota.",
      blockingWindow: blocked[0] ?? limits.tightest ?? null,
    };
  }

  const low = limits.windows
    .filter((w) => w.remainingPercent <= config.quotaLowRemainingPercent)
    .sort((a, b) => a.remainingPercent - b.remainingPercent);
  if (low.length > 0) {
    const w = low[0];
    return {
      state: "low",
      canDelegate: true,
      reason: `Codex quota is low: ${w.remainingPercent}% left in the ${w.window} window. Prefer a smaller task or a cheaper model.`,
      blockingWindow: w,
    };
  }

  return {
    state: "ok",
    canDelegate: true,
    reason: limits.tightest
      ? `Codex quota OK: ${limits.tightest.remainingPercent}% left in the tightest (${limits.tightest.window}) window.`
      : "Codex quota OK.",
    blockingWindow: null,
  };
}

/** Detect a quota failure from a turn error, so we hand off instead of retrying. */
export function isQuotaError(
  error: { message?: string; codexErrorInfo?: unknown } | null | undefined,
): boolean {
  if (!error) return false;
  const info = error.codexErrorInfo;
  if (typeof info === "string") {
    if (info === "usageLimitExceeded" || info === "sessionBudgetExceeded") return true;
  } else if (info && typeof info === "object") {
    const key = Object.keys(info)[0];
    if (key === "usageLimitExceeded" || key === "sessionBudgetExceeded") return true;
  }
  const msg = (error.message ?? "").toLowerCase();
  return (
    msg.includes("usage limit") ||
    msg.includes("rate limit") ||
    msg.includes("quota exceeded") ||
    msg.includes("quota exhausted")
  );
}
