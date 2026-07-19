/**
 * Model-routing dispatcher (T9).
 *
 * `routeAndExecute` runs the Haiku triage (`./triage.ts`) — or the vision
 * fast-path when `opts.hasImage` is set — then makes the actual action call
 * on whichever tier was chosen, using the caller-supplied API key. This is a
 * thin dispatcher: the "action" here is a generic calendar-assistant system
 * prompt, not real tool-calling. Tool-calling integration (calendar
 * create/edit/etc.) is wired in later; the point of this task is that the
 * chosen tier actually executes a real model call end-to-end.
 */
import Anthropic from "@anthropic-ai/sdk";
import { triage } from "./triage";
import { MODELS, type RouteAndExecuteOptions, type RouteAndExecuteResult } from "./types";

const DEFAULT_SYSTEM =
  "You are a helpful personal calendar assistant. Handle the user's calendar request directly and concisely.";

const DEFAULT_MAX_TOKENS = 1024;

/**
 * Triage the request, then execute it on the chosen model.
 *
 * @param request - The user's calendar request (natural language).
 * @param opts - `apiKey` (falls back to `ANTHROPIC_API_KEY`), `hasImage`/`imageDense`
 *   (vision fast-path — see `triage()`), `system` (override the action system
 *   prompt), `maxTokens` (override the action call's `max_tokens`).
 */
export async function routeAndExecute(
  request: string,
  opts: RouteAndExecuteOptions = {},
): Promise<RouteAndExecuteResult> {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No Anthropic API key available for routeAndExecute(). Pass opts.apiKey (the user-supplied key) " +
        "or set ANTHROPIC_API_KEY for local/testing.",
    );
  }

  const route = await triage(request, {
    hasImage: opts.hasImage,
    imageDense: opts.imageDense,
    apiKey,
  });
  const model = MODELS[route];

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: opts.system ?? DEFAULT_SYSTEM,
    messages: [{ role: "user", content: request }],
  });

  const result = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return { route, model, result };
}
