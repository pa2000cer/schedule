/**
 * Haiku triage (T9) — a fast, tiny classification call that decides which
 * Claude tier should handle a calendar request, before any real work happens.
 *
 * ## Rules (per the vault's Model Routing note)
 *   - `haiku`  — simple/deterministic: toggle a task done, fetch a day, trivial lookups.
 *   - `sonnet` — everyday create/edit: add an appointment, reschedule, summarize the day.
 *   - `opus`   — complex/multi-step: reorganize a week, resolve conflicts, plan around constraints.
 *
 * ## Vision fast-path
 * When `opts.hasImage` is set, the Haiku triage call is skipped entirely —
 * vision quality on Haiku is not worth the round trip. Route directly to the
 * vision tier: `sonnet` by default, `opus` when the image is dense/ambiguous
 * (`opts.imageDense`).
 *
 * ## Parsing
 * Haiku is asked to answer with exactly one word. Real models sometimes wrap
 * that in quotes, punctuation, or a short sentence anyway, so parsing is
 * robust: strip whitespace/quotes, then fall back to a regex scan for one of
 * the three tier words. If nothing recognizable comes back, default to
 * `sonnet` (the safe middle tier) and log a warning — this is the
 * confidence-escalation path: we never silently fail closed to `haiku` on an
 * unparseable response, since under-provisioning a genuinely complex request
 * is worse than over-provisioning a simple one.
 */
import Anthropic from "@anthropic-ai/sdk";
import { MODELS, type Route, type TriageOptions } from "./types";

const VALID_ROUTES: readonly Route[] = ["haiku", "sonnet", "opus"];

const TRIAGE_SYSTEM = [
  "You are a routing classifier for a personal calendar assistant.",
  "Classify the user's request into exactly one tier and reply with ONLY that single word — no punctuation, no explanation, no quotes.",
  "",
  "Tiers:",
  "haiku - simple, deterministic actions: marking/toggling a task done, fetching or looking up a day or event, trivial yes/no questions about the calendar.",
  "sonnet - everyday create/edit actions: adding an appointment or task, rescheduling or moving a single event, summarizing a day.",
  "opus - complex reasoning or multi-step planning: reorganizing a week, resolving scheduling conflicts, planning around multiple constraints.",
  "",
  "Reply with exactly one word: haiku, sonnet, or opus.",
].join("\n");

/** Strip surrounding whitespace/quotes/trailing punctuation, then lowercase. */
function normalize(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?,:;]+$/g, "")
    .trim()
    .toLowerCase();
}

/** Turn Haiku's raw text output into a `Route`, robustly. */
function parseRoute(raw: string): Route {
  const normalized = normalize(raw);
  if ((VALID_ROUTES as readonly string[]).includes(normalized)) {
    return normalized as Route;
  }

  // Noisy output (extra words/sentence around the label) — recover the first
  // tier word mentioned rather than giving up outright.
  const match = normalized.match(/\b(haiku|sonnet|opus)\b/);
  if (match) {
    console.warn(
      `[routing] triage returned noisy output (${JSON.stringify(raw)}); recovered route "${match[1]}" via fallback parse.`,
    );
    return match[1] as Route;
  }

  console.warn(
    `[routing] triage returned unrecognized output (${JSON.stringify(raw)}); defaulting to "sonnet".`,
  );
  return "sonnet";
}

/**
 * Classify a request into a routing tier.
 *
 * Skips the Haiku call entirely when `opts.hasImage` is set (see module doc).
 * Otherwise makes one small `claude-haiku-4-5-20251001` call and parses the
 * single-word response.
 */
export async function triage(request: string, opts: TriageOptions = {}): Promise<Route> {
  if (opts.hasImage) {
    return opts.imageDense ? "opus" : "sonnet";
  }

  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No Anthropic API key available for triage(). Pass opts.apiKey or set ANTHROPIC_API_KEY.",
    );
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODELS.haiku,
    max_tokens: 8,
    system: TRIAGE_SYSTEM,
    messages: [{ role: "user", content: request }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join(" ");

  return parseRoute(text);
}
