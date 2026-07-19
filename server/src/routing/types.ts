/**
 * Shared types for the model-routing layer (T9).
 *
 * Every calendar action is routed to one of three Claude tiers after a fast
 * Haiku triage call. See `./triage.ts` for the classifier and `./router.ts`
 * for the dispatcher that actually executes the chosen tier.
 */

/** The three routing tiers, in ascending capability/cost order. */
export type Route = "haiku" | "sonnet" | "opus";

/**
 * Exact current model IDs (per the vault's Model Routing note, 2026-07-18).
 * Do not substitute other aliases here — these are the pinned, authoritative
 * strings for this task.
 */
export const MODELS: Record<Route, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
};

/** Options that influence triage — primarily the vision/image fast-path. */
export interface TriageOptions {
  /**
   * True when the request includes an image. When set, `triage()` skips the
   * Haiku classification call entirely and routes directly to the vision
   * tier: `sonnet` by default, or `opus` when `imageDense` is also true.
   */
  hasImage?: boolean;
  /** True when the attached image is dense/ambiguous and needs Opus-tier vision. */
  imageDense?: boolean;
  /** API key to use for the triage call itself. Falls back to `ANTHROPIC_API_KEY`. */
  apiKey?: string;
}

/** Options for `routeAndExecute` — triage options plus the execution call. */
export interface RouteAndExecuteOptions extends TriageOptions {
  /** User-supplied Anthropic API key. Falls back to `ANTHROPIC_API_KEY` for local/testing. */
  apiKey?: string;
  /** System prompt for the action call. Defaults to a generic calendar-assistant prompt. */
  system?: string;
  /** `max_tokens` for the action call. Defaults to 1024. */
  maxTokens?: number;
}

/** Result of `routeAndExecute` — the chosen tier, the concrete model id, and its text output. */
export interface RouteAndExecuteResult {
  route: Route;
  model: string;
  result: string;
}
