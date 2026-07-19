/**
 * Per-caller context seam for the MCP calendar/task tools (T7 → T20).
 *
 * The event store is now Firestore (see `../../calendar/calendar`), which
 * authenticates via ADC — there is **no Google auth to inject** per request. This
 * seam therefore carries only optional non-secret context (calendar id, timezone),
 * set the same module-level-singleton way as before. Tools are registered once at
 * server construction and read `getCalendarId()` / `getTimeZone()` here.
 */
import { DEFAULT_TIME_ZONE } from "../../calendar/calendar";

/** Injected per-caller context (non-secret). */
export interface ToolContext {
  calendarId?: string;
  timeZone?: string;
}

let injected: ToolContext | null = null;

/** Inject per-caller context (route wiring / tests). Pass `null` to clear. */
export function setToolContext(ctx: ToolContext | null): void {
  injected = ctx;
}

/** The currently-active context, or `null`. */
export function getToolContext(): ToolContext | null {
  return injected;
}

/** Calendar id for the current caller (override, env, or "primary"). */
export function getCalendarId(): string {
  return injected?.calendarId ?? process.env.CALENDAR_ID ?? process.env.GOOGLE_CALENDAR_ID ?? "primary";
}

/** IANA timezone for the current caller (override or the module default). */
export function getTimeZone(): string {
  return injected?.timeZone ?? DEFAULT_TIME_ZONE;
}

/** Shared JSON tool-result shape. Serializes `payload` as text content. */
export function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** Shared error tool-result (isError=true) so the client sees a structured failure. */
export function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  };
}
