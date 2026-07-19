/**
 * Recurring-event tools (T7): `add_recurring`, `update_recurring`,
 * `delete_recurring`.
 *
 * These operate on **Google recurring events** (an RRULE on a master event) —
 * the mutable "recurring" surface. (The T8 grooming routine is a separate,
 * read-only source and is NOT touched here; see `list_grooming_tasks`.)
 *
 * ## Instance vs. series (explicit `scope`)
 *
 * Google models recurrence as one MASTER event (id `E`) that expands into
 * INSTANCES, each with its own id (e.g. `E_20260720T130000Z`). We expose both
 * via a `scope` param:
 *   - `scope: "series"` (default) — the `id` is the master id; the change
 *     applies to the whole series (patching the RRULE / all fields, or deleting
 *     every occurrence).
 *   - `scope: "instance"` — the `id` is a single INSTANCE id (obtained from
 *     `get_day`, which expands `singleEvents`, or from `listEventInstances`).
 *     Updating patches only that occurrence (Google records an exception);
 *     deleting removes only that occurrence (Google adds an EXDATE).
 *
 * (Note: `delete_task` on an instance id has the same effect as
 * `delete_recurring scope:"instance"`; this tool makes the intent explicit and
 * additionally supports whole-series deletion.)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createEvent,
  updateEvent,
  cancelEvent,
  buildRRule,
  type UpdateEventPatch,
  type RecurrenceSpec,
} from "../../calendar/calendar";
import { getCalendarId, getTimeZone, jsonResult, errorResult } from "./context";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDateTime = z.string().describe("ISO 8601 datetime, e.g. 2026-07-18T09:00:00-04:00.");

const recurrenceSpecSchema = z.object({
  freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
  interval: z.number().int().positive().optional().describe("Repeat every N periods."),
  byDay: z
    .array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]))
    .optional()
    .describe("Weekdays for WEEKLY rules, e.g. [MO,WE,FR]."),
  count: z.number().int().positive().optional().describe("Stop after N occurrences."),
  until: z.string().regex(DATE_RE).optional().describe("Last date, YYYY-MM-DD (inclusive)."),
});

const scopeSchema = z
  .enum(["series", "instance"])
  .default("series")
  .describe("'series' = the whole recurring rule (id is the master); 'instance' = one occurrence (id is an instance id).");

export function registerRecurringTools(server: McpServer): void {
  server.registerTool(
    "add_recurring",
    {
      title: "Add Recurring Event",
      description:
        "Create a Google recurring event from an RRULE spec. `start`/`end` are ISO datetimes for the " +
        "FIRST occurrence. Set `task:true` to make the series task-flagged. Returns the series master.",
      inputSchema: {
        title: z.string().min(1),
        start: isoDateTime.describe("First occurrence start (ISO)."),
        end: isoDateTime.optional().describe("First occurrence end (ISO); defaults to start."),
        recurrence: recurrenceSpecSchema,
        location: z.string().optional(),
        notes: z.string().optional(),
        task: z.boolean().optional().describe("Make the series task-style; default false."),
        timeZone: z.string().optional(),
      },
    },
    async ({ title, start, end, recurrence, location, notes, task, timeZone }) => {
      try {
        const rrule = buildRRule(recurrence as RecurrenceSpec);
        const item = await createEvent(
          {
            title,
            start,
            end,
            location,
            notes,
            task: task ?? false,
            recurrence: rrule,
            timeZone: timeZone ?? getTimeZone(),
          },
          getCalendarId(),
        );
        return jsonResult({ ok: true, series: item, rrule });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "update_recurring",
    {
      title: "Update Recurring Event",
      description:
        "Update a recurring event. scope='series' (default) patches the master (fields and/or a new " +
        "RRULE via `recurrence`); scope='instance' patches only the occurrence whose instance id is `id`.",
      inputSchema: {
        id: z.string().min(1).describe("Master id (scope=series) or instance id (scope=instance)."),
        scope: scopeSchema,
        title: z.string().min(1).optional(),
        start: isoDateTime.optional(),
        end: isoDateTime.optional(),
        location: z.string().optional(),
        notes: z.string().optional(),
        recurrence: recurrenceSpecSchema
          .optional()
          .describe("Series scope only: replace the recurrence rule."),
        timeZone: z.string().optional(),
      },
    },
    async ({ id, scope, title, start, end, location, notes, recurrence, timeZone }) => {
      try {
        if (scope === "instance" && recurrence) {
          return errorResult("`recurrence` cannot be changed on a single instance (use scope='series').");
        }
        const patch: UpdateEventPatch = { title, start, end, location, notes };
        if (start !== undefined || end !== undefined) patch.timeZone = timeZone ?? getTimeZone();
        if (scope === "series" && recurrence) patch.recurrence = buildRRule(recurrence as RecurrenceSpec);
        const item = await updateEvent(id, patch, getCalendarId());
        return jsonResult({ ok: true, scope, event: item });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "delete_recurring",
    {
      title: "Delete Recurring Event",
      description:
        "Delete a recurring event. scope='series' (default) deletes the whole series (master id); " +
        "scope='instance' deletes only the occurrence whose instance id is `id` (Google adds an EXDATE).",
      inputSchema: {
        id: z.string().min(1).describe("Master id (scope=series) or instance id (scope=instance)."),
        scope: scopeSchema,
      },
    },
    async ({ id, scope }) => {
      try {
        // Both cases are a Google events.delete; the id kind (master vs instance)
        // determines whether the series or a single occurrence is removed.
        await cancelEvent(id, getCalendarId());
        return jsonResult({ ok: true, scope, deletedId: id });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
