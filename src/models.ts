import { config } from "./config.js";
import type { Model } from "./protocol.js";

/**
 * Reasoning efforts from lightest to heaviest. Codex treats effort as an open
 * string, so anything unknown sorts last and is never used for capping.
 */
export const EFFORT_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export type ModelTier = "fast" | "balanced" | "frontier";

export interface ModelPolicyEntry {
  id: string;
  aliases: string[];
  tier: ModelTier;
  /** Heaviest effort the router will send. Requests above it are clamped. */
  maxEffort: string;
  defaultEffort: string;
  summary: string;
  useFor: string;
}

/**
 * Which models the router steers work towards, and how hard it lets each one
 * think. This is a preference layer only: the catalogue itself is always read
 * live from Codex, and a policy model missing from it is reported as unavailable
 * rather than assumed to exist.
 */
const DEFAULT_POLICY: ModelPolicyEntry[] = [
  {
    id: "gpt-6-luna",
    aliases: ["luna", "fast"],
    tier: "fast",
    maxEffort: "xhigh",
    defaultEffort: "medium",
    summary: "Light reasoning, the lowest quota use, the fastest.",
    useFor:
      "Mechanical edits, boilerplate, tests that follow an existing pattern, quick lookups, image generation.",
  },
  {
    id: "gpt-6-sol",
    aliases: ["sol", "balanced"],
    tier: "balanced",
    maxEffort: "high",
    defaultEffort: "medium",
    summary: "Medium reasoning at medium quota use.",
    useFor: "Everyday feature work, bug fixes with a known cause, most code review.",
  },
  {
    id: "gpt-6-astra",
    aliases: ["astra", "frontier", "best"],
    tier: "frontier",
    maxEffort: "high",
    defaultEffort: "medium",
    summary: "The strongest reasoning, and the heaviest on quota.",
    useFor:
      "Hard debugging, algorithm design, cross-cutting changes, second-opinion review of critical code.",
  },
];

function loadPolicy(): ModelPolicyEntry[] {
  const raw = process.env.AGENT_ROUTER_MODEL_POLICY;
  if (!raw) return DEFAULT_POLICY;
  try {
    // Entries may be partial: only `id` is required, the rest has defaults.
    const parsed = JSON.parse(raw) as (Partial<ModelPolicyEntry> & { id: string })[];
    if (Array.isArray(parsed) && parsed.every((e) => e && typeof e.id === "string")) {
      return parsed.map((e): ModelPolicyEntry => ({
        aliases: [],
        tier: "balanced",
        maxEffort: "high",
        defaultEffort: "medium",
        summary: "",
        useFor: "",
        ...e,
      }));
    }
  } catch {
    // fall through to the default policy
  }
  process.stderr.write("[agent-router] AGENT_ROUTER_MODEL_POLICY is not a valid JSON array; using the default policy\n");
  return DEFAULT_POLICY;
}

export const MODEL_POLICY = loadPolicy();

export function effortRank(effort: string): number {
  const i = EFFORT_LADDER.indexOf(effort);
  return i === -1 ? Number.POSITIVE_INFINITY : i;
}

/** The policy entry for a model id or alias, if the model is governed by policy. */
export function policyFor(idOrAlias: string): ModelPolicyEntry | undefined {
  const needle = idOrAlias.trim().toLowerCase();
  return MODEL_POLICY.find(
    (e) => e.id.toLowerCase() === needle || e.aliases.some((a) => a.toLowerCase() === needle),
  );
}

export interface ResolvedModel {
  /** Null only when Codex should fall back to the account default. */
  model: string | null;
  effort: string | null;
  notes: string[];
}

/**
 * Turn a requested model/effort (either may be omitted or an alias) into what is
 * actually sent to Codex, enforcing the policy's effort caps.
 *
 * Capping clamps rather than refuses: an over-eager effort is a cost decision,
 * not an error, and a refusal would cost the caller a wasted round trip.
 */
export function resolveModel(
  catalogue: Model[],
  requestedModel: string | undefined,
  requestedEffort: string | undefined,
  fallback: { model?: string; effort?: string } = {},
): ResolvedModel {
  const notes: string[] = [];
  const available = (id: string) => catalogue.find((m) => m.id === id || m.model === id);

  let entry: ModelPolicyEntry | undefined;
  let chosen: Model | undefined;

  if (requestedModel) {
    entry = policyFor(requestedModel);
    const id = entry?.id ?? requestedModel;
    chosen = available(id);
    if (!chosen) {
      const recommended = MODEL_POLICY.filter((e) => available(e.id)).map((e) => e.id);
      throw new Error(
        `Codex model "${requestedModel}" is not available to this account. ` +
          (recommended.length
            ? `Recommended: ${recommended.join(", ")}. `
            : "") +
          `All available: ${catalogue.map((m) => m.id).join(", ")}.`,
      );
    }
    if (!entry) {
      notes.push(
        `${chosen.id} is outside the router's model policy (${MODEL_POLICY.map((e) => e.id).join(", ")}). It will run, but prefer a recommended model.`,
      );
    }
  } else {
    const preferred = fallback.model ?? config.defaultModel;
    entry = preferred ? policyFor(preferred) : undefined;
    chosen = available(entry?.id ?? preferred ?? "");
    if (!chosen) {
      // The preferred default is not in this account's catalogue yet (older
      // Codex CLI, or not rolled out); let Codex use the account default.
      chosen = catalogue.find((m) => m.isDefault);
      if (preferred) {
        notes.push(
          `Default model ${preferred} is not available to this account; using Codex's default${chosen ? ` (${chosen.id})` : ""}. Updating the Codex CLI may expose it.`,
        );
      }
      if (!chosen) return { model: null, effort: requestedEffort ?? null, notes };
      // The account default may itself be a policy model; its cap still applies.
      entry = policyFor(chosen.id);
    }
  }

  const supported = chosen.supportedReasoningEfforts.map((r) => r.reasoningEffort);
  let effort = requestedEffort ?? fallback.effort ?? entry?.defaultEffort ?? null;

  if (effort && entry && effortRank(effort) !== Number.POSITIVE_INFINITY) {
    if (effortRank(effort) > effortRank(entry.maxEffort)) {
      notes.push(
        `Reasoning effort "${effort}" is above the policy cap for ${entry.id}; capped at "${entry.maxEffort}".`,
      );
      effort = entry.maxEffort;
    }
  }

  if (effort && !supported.includes(effort)) {
    throw new Error(
      `Model "${chosen.id}" does not support reasoning effort "${effort}". Supported: ${allowedEfforts(chosen, entry).join(", ")}.`,
    );
  }

  return { model: chosen.id, effort, notes };
}

/** The efforts a caller may actually pick for a model, after the policy cap. */
export function allowedEfforts(model: Model, entry = policyFor(model.id)): string[] {
  const supported = model.supportedReasoningEfforts.map((r) => r.reasoningEffort);
  if (!entry) return supported;
  return supported.filter((e) => effortRank(e) <= effortRank(entry.maxEffort));
}

export function describeCatalogue(catalogue: Model[]): unknown {
  const byId = new Map(catalogue.map((m) => [m.id, m]));
  const recommended = MODEL_POLICY.map((entry) => {
    const live = byId.get(entry.id);
    return {
      id: entry.id,
      aliases: entry.aliases,
      tier: entry.tier,
      available: Boolean(live),
      summary: entry.summary,
      useFor: entry.useFor,
      defaultEffort: entry.defaultEffort,
      maxEffort: entry.maxEffort,
      reasoningEfforts: live
        ? allowedEfforts(live, entry).map((effort) => ({
            effort,
            description:
              live.supportedReasoningEfforts.find((r) => r.reasoningEffort === effort)?.description ?? "",
          }))
        : [],
      ...(live ? {} : { note: "Not in this account's live catalogue — update the Codex CLI or check your plan." }),
    };
  });

  const governed = new Set(MODEL_POLICY.map((e) => e.id));
  const otherModels = catalogue
    .filter((m) => !governed.has(m.id))
    .map((m) => ({
      id: m.id,
      reasoningEfforts: m.supportedReasoningEfforts.map((r) => r.reasoningEffort),
      supersededBy: m.upgrade,
      note: "Outside the router's model policy: usable if named explicitly, but prefer a recommended model.",
    }));

  // Advertise exactly what an omitted model would resolve to, by the same logic
  // delegation uses — including an off-policy AGENT_ROUTER_DEFAULT_MODEL.
  let resolvedDefault: ResolvedModel = { model: null, effort: null, notes: [] };
  try {
    resolvedDefault = resolveModel(catalogue, undefined, undefined);
  } catch {
    // an unsatisfiable default is reported as null rather than failing the listing
  }
  return {
    defaultModel: resolvedDefault.model,
    defaultEffort: resolvedDefault.effort,
    policy:
      "Pick by task difficulty: luna for mechanical work, sol for everyday work, astra for the hardest problems. Reasoning is capped per model (see maxEffort); higher requests are clamped. Aliases (luna, sol, astra, fast, balanced, frontier) are accepted anywhere a model id is.",
    recommended,
    otherModels,
  };
}
