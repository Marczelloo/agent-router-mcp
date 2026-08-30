/**
 * Minimal, hand-picked subset of the `codex app-server` protocol.
 *
 * The full set of bindings can be regenerated at any time with:
 *   codex app-server generate-ts --out <dir>
 *   codex app-server generate-json-schema --out <dir>
 *
 * We only mirror the shapes the router actually reads, so a Codex upgrade that
 * adds fields elsewhere cannot break this build.
 */

export type JsonValue = unknown;

export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
    mcpServerOpenaiFormElicitation?: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

/** `"low" | "medium" | "high" | "xhigh" | "max" | "ultra" | ...` — open-ended by design. */
export type ReasoningEffort = string;

export interface ReasoningEffortOption {
  reasoningEffort: ReasoningEffort;
  description: string;
}

export interface ModelServiceTier {
  id: string;
  name: string;
  description: string | null;
}

export interface Model {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: ReasoningEffort;
  inputModalities: string[];
  serviceTiers: ModelServiceTier[];
  defaultServiceTier: string | null;
  isDefault: boolean;
  upgrade: string | null;
}

export interface ModelListResponse {
  data: Model[];
  nextCursor: string | null;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export type RateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  spendControlReached: boolean | null;
  planType: string | null;
  rateLimitReachedType: RateLimitReachedType | null;
}

export interface RateLimitResetCredit {
  id: string;
  resetType: string;
  status: string;
  title: string | null;
  description: string | null;
  expiresAt: number | null;
}

export interface GetAccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
  rateLimitResetCredits: {
    availableCount: number;
    credits: RateLimitResetCredit[];
  } | null;
}

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type AskForApproval = "untrusted" | "on-request" | "never";

export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
  config?: Record<string, JsonValue> | null;
}

export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string;
}

export interface Thread {
  id: string;
  sessionId: string;
  preview: string;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  reasoningEffort: ReasoningEffort | null;
}

export type ThreadResumeResponse = ThreadStartResponse;

export type UserInput =
  | { type: "text"; text: string; text_elements?: unknown[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  model?: string | null;
  effort?: ReasoningEffort | null;
}

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "custom"; instructions: string };

export interface ReviewStartParams {
  threadId: string;
  target: ReviewTarget;
  /** "inline" keeps the review on the given thread; "detached" opens a new one. */
  delivery?: "inline" | "detached" | null;
}

export interface ReviewStartResponse {
  turn: Turn;
  reviewThreadId: string;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export type CodexErrorInfo =
  | "contextWindowExceeded"
  | "sessionBudgetExceeded"
  | "usageLimitExceeded"
  | "serverOverloaded"
  | "internalServerError"
  | "unauthorized"
  | "badRequest"
  | "other"
  | Record<string, unknown>;

export interface TurnError {
  message: string;
  codexErrorInfo: CodexErrorInfo | null;
  additionalDetails: string | null;
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: TurnStatus;
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface FileUpdateChange {
  path: string;
  kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null };
  diff: string;
}

/** Only the item variants the router inspects; anything else falls through as `unknown`. */
export type ThreadItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "plan"; id: string; text: string }
  | { type: "commandExecution"; id: string; command: string; status?: string }
  | { type: "fileChange"; id: string; changes: FileUpdateChange[]; status: string }
  | { type: string; id: string; [key: string]: unknown };

export interface TurnPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface TurnPlanUpdatedNotification {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: TurnPlanStep[];
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

export interface ItemCompletedNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface ErrorNotification {
  error: TurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

export interface TurnDiffUpdatedNotification {
  threadId: string;
  turnId: string;
  diff: string;
}

export interface AccountRateLimitsUpdatedNotification {
  rateLimits: RateLimitSnapshot;
}
