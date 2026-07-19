/**
 * Agentic calendar assistant (T12, Goal A).
 *
 * `runAssistant` turns a natural-language request into REAL calendar actions by
 * letting Claude drive the T7 MCP tools in a tool-calling loop:
 *
 *   1. Inject the caller's Google tokens via `setToolAuth(...)` so every tool
 *      call acts on their calendar (refresh token → auto-refreshing access).
 *   2. Connect an in-process MCP client to `createMcpServer()` and `listTools()`,
 *      converting each MCP tool's JSON-Schema `inputSchema` into an Anthropic
 *      `tools` entry (the schema is already JSON Schema — used verbatim).
 *   3. Pick the model tier with the T9 `triage(request)` router.
 *   4. Run an agentic loop: while the model returns `stop_reason:"tool_use"`,
 *      execute each requested tool through the MCP client, feed the results back
 *      as `tool_result` blocks, and continue (capped at ~8 iterations). A tool
 *      that throws is fed back as an `is_error` tool_result so the model can
 *      recover or report, rather than crashing the request.
 *   5. Return `{ finalText, actions, route, model }` — `actions` lists the tool
 *      calls actually executed so the UI can show what happened.
 *
 * `setToolAuth(null)` is always cleared in a `finally`, and the in-process MCP
 * transport is torn down, so no per-request auth or connection leaks.
 *
 * Design notes:
 *   - The loop (`runAgentLoop`) and the tool-schema converter
 *     (`mcpToolsToAnthropic`) are exported and dependency-injected so they can be
 *     unit-tested with a mocked Anthropic client and mocked tool execution —
 *     no live Google/Anthropic access needed (see scratchpad tests / Work Log).
 *   - No `thinking` config is set: the tier can be Haiku, Sonnet, or Opus, and
 *     adaptive-thinking support differs across those families. Omitting it keeps
 *     one code path valid on every tier. Tool orchestration doesn't need it.
 */
import Anthropic from "@anthropic-ai/sdk";
import { triage } from "../routing/triage";
import { MODELS, type Route } from "../routing/types";
import { setToolContext } from "../mcp/tools/context";
import { connectInProcessMcp, type McpToolInfo } from "../mcp/inProcessClient";
import { DEFAULT_TIME_ZONE, todayInTimeZone } from "../calendar/calendar";

/** One tool call actually executed during the loop, with a compact result summary. */
export interface AssistantAction {
  name: string;
  input: unknown;
  resultSummary: string;
  isError: boolean;
}

/** What `runAssistant` returns to the caller/route. */
export interface RunAssistantResult {
  finalText: string;
  actions: AssistantAction[];
  route: Route;
  model: string;
}

export interface RunAssistantOptions {
  /** Anthropic API key. Falls back to `ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** IANA timezone the assistant resolves relative dates against. Falls back to APP_TIMEZONE. */
  timeZone?: string;
  /** Server "today" (YYYY-MM-DD) in `timeZone`. Falls back to the real clock. */
  today?: string;
  /** Calendar id override (defaults to "primary" via the tool context). */
  calendarId?: string;
  /** Agentic-loop iteration cap (default 8). */
  maxIterations?: number;
}

/**
 * Convert MCP tool descriptors into Anthropic `tools` entries. The MCP
 * `inputSchema` is already valid JSON Schema, so it is used directly.
 * Exported for unit testing.
 */
export function mcpToolsToAnthropic(mcpTools: McpToolInfo[]): Anthropic.Tool[] {
  return mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
  }));
}

/** Build the calendar-assistant system prompt, pinned to today's date + timezone. */
export function buildSystemPrompt(today: string, timeZone: string): string {
  return [
    "You are a personal calendar assistant that manages the user's real Google Calendar.",
    `Today's date is ${today} and the user's timezone is ${timeZone}.`,
    "Resolve relative dates ('today', 'tomorrow', 'this Friday', 'next week') against that date and timezone.",
    "",
    "You have tools that read and MODIFY the real calendar. You MUST call the tools to make any change —",
    "never claim to have added, edited, completed, rescheduled, or deleted anything without actually calling the",
    "corresponding tool. To answer 'what's on my calendar', call get_day.",
    "",
    "When a tool takes a datetime, pass an ISO 8601 local wall-clock value (e.g. 2026-07-19T15:00:00) and set the",
    "tool's timeZone argument when it has one. For all-day tasks use a YYYY-MM-DD date.",
    "",
    "CRITICAL — never invent a date or time, and never default to today or tonight. If the user references an event",
    "whose actual date or time you do not know for certain — for example a sports game (e.g. a World Cup match or an",
    "Indiana Fever game), a concert, a TV broadcast, a flight, or someone else's meeting — use the web_search tool to",
    "look up the real date and time BEFORE scheduling anything. Search for the specific fixture/event, read the",
    "result, confirm the date and start time, and convert it to the user's timezone above. Only then call a",
    "create/update tool. If the search is inconclusive or returns conflicting times, ask the user to confirm rather",
    "than guessing — it is always better to ask one clarifying question than to add an event at the wrong time.",
    "Dates the user gave you explicitly, or that follow unambiguously from a relative term like 'tomorrow' or 'this",
    "Friday', don't need a lookup.",
    "After the tools succeed, reply with a short, friendly confirmation of exactly what you did — and when you looked",
    "up a time, mention the date/time you found so the user can sanity-check it.",
  ].join("\n");
}

/**
 * Server-side web search tool (basic variant). Lets the assistant look up
 * real-world facts it doesn't know — sports fixtures, showtimes, etc. — before
 * scheduling. The basic `web_search_20250305` version is used deliberately: it
 * works on every tier the T9 router can pick (Haiku/Sonnet/Opus), whereas the
 * newer dynamic-filtering variant isn't supported on Haiku. Anthropic executes
 * it server-side within the same `messages.create` call, so the agent loop
 * doesn't run it — it just appears in the response content.
 */
export const WEB_SEARCH_TOOL: Anthropic.ToolUnion = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
};

/** Minimal Anthropic surface the loop needs — the real client satisfies it; tests pass a mock. */
type AnthropicLike = Pick<Anthropic, "messages">;

export interface AgentLoopDeps {
  anthropic: AnthropicLike;
  model: string;
  system: string;
  request: string;
  tools: Anthropic.ToolUnion[];
  /** Execute a tool by name, returning its JSON text result and error flag. */
  callTool: (name: string, input: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  maxIterations?: number;
  maxTokens?: number;
}

/** Compact, human-readable summary of a tool's JSON result for the actions list. */
function summarizeToolResult(text: string, isError: boolean): string {
  try {
    const p = JSON.parse(text) as Record<string, unknown>;
    if (isError || p.error) return `error: ${(p.error as string) ?? text.slice(0, 200)}`;
    const obj = (p.appointment ?? p.task ?? p.series ?? p.event) as Record<string, unknown> | undefined;
    if (obj && typeof obj === "object") {
      const title = (obj.title ?? obj.summary) as string | undefined;
      return title ? `ok: ${title}` : "ok";
    }
    if (Array.isArray(p.appointments) || Array.isArray(p.tasks) || Array.isArray(p.grooming)) {
      const a = Array.isArray(p.appointments) ? p.appointments.length : 0;
      const t = Array.isArray(p.tasks) ? p.tasks.length : 0;
      const g = Array.isArray(p.grooming) ? p.grooming.length : 0;
      return `day ${(p.date as string) ?? ""}: ${a} appts, ${t} tasks, ${g} grooming`;
    }
    return "ok";
  } catch {
    return text.slice(0, 200);
  }
}

/**
 * Run the agentic tool-calling loop. Pure of any Google/MCP wiring: tool
 * execution is injected via `deps.callTool`, so this is unit-testable with
 * mocks. Loops while the model asks for tools; stops on a final text answer or
 * when the iteration cap is hit.
 */
export async function runAgentLoop(
  deps: AgentLoopDeps,
): Promise<{ finalText: string; actions: AssistantAction[] }> {
  const maxIterations = deps.maxIterations ?? 8;
  const maxTokens = deps.maxTokens ?? 4096;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: deps.request }];
  const actions: AssistantAction[] = [];
  let lastText = "";

  for (let i = 0; i < maxIterations; i++) {
    const response = await deps.anthropic.messages.create({
      model: deps.model,
      max_tokens: maxTokens,
      system: deps.system,
      messages,
      tools: deps.tools,
    });

    const textParts = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text);
    if (textParts.length > 0) lastText = textParts.join("\n").trim();

    // Preserve the full assistant turn (text + tool_use blocks) for context.
    messages.push({ role: "assistant", content: response.content });

    // A server-side tool (web_search) hit its per-turn iteration cap: re-send
    // the conversation so Anthropic resumes it. No client-side work to do.
    if (response.stop_reason === "pause_turn") {
      continue;
    }

    if (response.stop_reason !== "tool_use") {
      return { finalText: lastText, actions };
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>;
      let text: string;
      let isError: boolean;
      try {
        const r = await deps.callTool(tu.name, input);
        text = r.text;
        isError = r.isError;
      } catch (err) {
        // Feed the failure back so the model can recover or report — don't crash.
        text = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        isError = true;
      }
      actions.push({ name: tu.name, input, resultSummary: summarizeToolResult(text, isError), isError });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: text, is_error: isError });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // Iteration cap reached without a final text answer.
  const finalText =
    lastText ||
    "I performed several actions but reached the step limit before finishing. Please check your calendar.";
  return { finalText, actions };
}

/**
 * Perform real calendar actions for `request` on behalf of the caller's Google
 * session. See the module doc for the full flow.
 */
export async function runAssistant(
  request: string,
  opts: RunAssistantOptions,
): Promise<RunAssistantResult> {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No Anthropic API key available for runAssistant(). Pass opts.apiKey or set ANTHROPIC_API_KEY.",
    );
  }
  const timeZone = opts.timeZone || DEFAULT_TIME_ZONE;
  const today = opts.today || todayInTimeZone(timeZone);

  // Set the non-secret tool context for the duration of this request. The store
  // is Firestore (ADC) — no Google auth to inject.
  setToolContext({
    calendarId: opts.calendarId,
    timeZone,
  });

  const mcp = await connectInProcessMcp();
  try {
    // Calendar CRUD tools (from the MCP server) + a server-side web_search tool
    // so the assistant can look up real dates/times it doesn't know before scheduling.
    const tools: Anthropic.ToolUnion[] = [
      ...mcpToolsToAnthropic(await mcp.listTools()),
      WEB_SEARCH_TOOL,
    ];
    const route = await triage(request, { apiKey });
    const model = MODELS[route];
    const anthropic = new Anthropic({ apiKey });

    // eslint-disable-next-line no-console
    console.log(
      `[assistant] today=${today} tz=${timeZone} route=${route} model=${model} request=${JSON.stringify(request.slice(0, 300))}`,
    );

    const { finalText, actions } = await runAgentLoop({
      anthropic,
      model,
      system: buildSystemPrompt(today, timeZone),
      request,
      tools,
      callTool: async (name, input) => {
        // eslint-disable-next-line no-console
        console.log(`[assistant] tool_call ${name} input=${JSON.stringify(input).slice(0, 400)}`);
        const r = await mcp.callTool(name, input);
        // eslint-disable-next-line no-console
        console.log(`[assistant] tool_result ${name} isError=${r.isError} -> ${r.text.slice(0, 300)}`);
        return r;
      },
      maxIterations: opts.maxIterations ?? 8,
    });

    // eslint-disable-next-line no-console
    console.log(
      `[assistant] done actions=${actions.length} [${actions.map((a) => a.name).join(",")}]`,
    );
    return { finalText, actions, route, model };
  } finally {
    await mcp.close();
    setToolContext(null);
  }
}
