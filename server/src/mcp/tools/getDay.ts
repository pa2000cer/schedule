/**
 * `get_day` (T7) — merged one-day view.
 *
 * ## Merge model
 *
 * Three sources are combined for a single local calendar day:
 *
 *   1. **Google Calendar events** for the day (`listDayEvents`, `singleEvents`
 *      so recurring series are expanded to concrete instances). Each event is
 *      `classify()`-ed by the T5 heuristic into:
 *        - `appointments` — timed commitments (`kind === "appointment"`).
 *        - `tasks` — all-day / `[task]`-prefixed / transparent events
 *          (`kind === "task"`), each carrying a `done` flag read from
 *          `extendedProperties.private.status` (T7 done-state).
 *   2. **Grooming routine tasks** (T8, `getGroomingTasks`) — a READ-ONLY,
 *      statically-defined daily routine. Returned in their own `grooming`
 *      array (not mutated, not written to Google). They are deliberately kept
 *      separate from `tasks` so the front end can render the fixed routine
 *      distinctly and callers never try to CRUD them here.
 *
 * The three arrays are returned side-by-side (no dedupe across sources — they
 * are disjoint by construction: grooming is a static module, appointments/tasks
 * come from Google). Appointments/tasks keep `listDayEvents`' start-time order.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listDayEvents } from "../../calendar/calendar";
import { getGroomingTasks } from "../../grooming/schedule";
import { getGroomingDone, groomingId } from "../../grooming/completion";
import { getCalendarId, getTimeZone, jsonResult, errorResult } from "./context";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a `YYYY-MM-DD` string into a Date at LOCAL midnight (for T8 grooming, which uses local getDay/getDate). */
function localDateFromStr(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function registerGetDayTool(server: McpServer): void {
  server.registerTool(
    "get_day",
    {
      title: "Get Day",
      description:
        "Return the merged one-day view for a date: { date, appointments, tasks (with done-state), grooming }. " +
        "Appointments and tasks come from Google Calendar (recurring series expanded to instances); grooming " +
        "is the read-only weekly routine (T8).",
      inputSchema: {
        date: z
          .string()
          .regex(DATE_RE, "date must be YYYY-MM-DD")
          .describe("Local calendar day to fetch, as YYYY-MM-DD."),
      },
    },
    async ({ date }) => {
      try {
        const items = await listDayEvents(date, getCalendarId(), getTimeZone());
        const appointments = items.filter((i) => i.kind === "appointment");
        const tasks = items
          .filter((i) => i.kind === "task")
          .map((i) => ({ ...i, done: i.done ?? false }));
        const doneSet = await getGroomingDone(date);
        const grooming = getGroomingTasks(localDateFromStr(date)).map((g) => {
          const id = groomingId(g.time, g.title);
          return { ...g, id, done: doneSet.has(id) };
        });
        return jsonResult({ date, appointments, tasks, grooming });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
