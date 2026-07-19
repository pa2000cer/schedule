/**
 * Task CRUD tools (T7): `add_task`, `update_task`, `complete_task`,
 * `reschedule_task`, `delete_task`.
 *
 * A task is a Google Calendar event flagged as task-style (title prefixed
 * `[task]` + transparency=transparent, via T5 `task: true`). Tasks may be:
 *   - **all-day** — provide `date` (YYYY-MM-DD); stored as a date-only event.
 *   - **timed**   — provide `start`/`end` (ISO datetimes).
 *
 * Done-state lives in `extendedProperties.private.status` (`done`/`todo`) so it
 * persists in Google and survives reload — no separate datastore needed.
 * `complete_task` toggles/sets it. `reschedule_task` moves the task to a new
 * day (all-day) or new times (timed). Deletes propagate to Google.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createEvent,
  updateEvent,
  cancelEvent,
  addDaysToDateStr,
  type CreateEventInput,
  type UpdateEventPatch,
} from "../../calendar/calendar";
import { getCalendarId, getTimeZone, jsonResult, errorResult } from "./context";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateStr = z.string().regex(DATE_RE, "must be YYYY-MM-DD");
const isoDateTime = z.string().describe("ISO 8601 datetime, e.g. 2026-07-18T14:00:00-04:00.");

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    "add_task",
    {
      title: "Add Task",
      description:
        "Create a task (Google Calendar event, task-flagged). Provide `date` for an all-day task " +
        "OR `start`/`end` for a timed task. Optionally mark initial done-state.",
      inputSchema: {
        title: z.string().min(1),
        date: dateStr.optional().describe("All-day task date (YYYY-MM-DD)."),
        start: isoDateTime.optional().describe("Timed task start (ISO)."),
        end: isoDateTime.optional().describe("Timed task end (ISO)."),
        notes: z.string().optional(),
        done: z.boolean().optional().describe("Initial done-state; default false."),
        timeZone: z.string().optional(),
      },
    },
    async ({ title, date, start, end, notes, done, timeZone }) => {
      try {
        if (!date && !start) {
          return errorResult("add_task requires either `date` (all-day) or `start` (timed).");
        }
        const input: CreateEventInput = date
          ? {
              // All-day event; Google end date is EXCLUSIVE, so +1 day for a single-day task.
              title,
              start: date,
              end: addDaysToDateStr(date, 1),
              allDay: true,
              notes,
              task: true,
              status: done ? "done" : "todo",
            }
          : {
              title,
              start: start!,
              end: end ?? start!,
              allDay: false,
              notes,
              task: true,
              timeZone: timeZone ?? getTimeZone(),
              status: done ? "done" : "todo",
            };
        const item = await createEvent(input, getCalendarId());
        return jsonResult({ ok: true, task: item });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update Task",
      description: "Patch a task's title/notes/times. Only provided fields change.",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().min(1).optional(),
        notes: z.string().optional(),
        start: isoDateTime.optional(),
        end: isoDateTime.optional(),
        timeZone: z.string().optional(),
      },
    },
    async ({ id, title, notes, start, end, timeZone }) => {
      try {
        const patch: UpdateEventPatch = { title, notes, start, end };
        if (start !== undefined || end !== undefined) patch.timeZone = timeZone ?? getTimeZone();
        const item = await updateEvent(id,patch, getCalendarId());
        return jsonResult({ ok: true, task: item });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete Task",
      description:
        "Set a task's done-state (extendedProperties.private.status). done=true marks complete, " +
        "done=false reopens. Works on a single recurring instance id too (marks just that occurrence).",
      inputSchema: {
        id: z.string().min(1).describe("Task event id (or recurring instance id)."),
        done: z.boolean().optional().describe("Target done-state; default true."),
      },
    },
    async ({ id, done }) => {
      try {
        const status = done === false ? "todo" : "done";
        const item = await updateEvent(id,{ status }, getCalendarId());
        return jsonResult({ ok: true, task: item, done: status === "done" });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "reschedule_task",
    {
      title: "Reschedule Task",
      description:
        "Move a task to a new day (all-day, via `date`) or new times (timed, via `start`/`end`).",
      inputSchema: {
        id: z.string().min(1),
        date: dateStr.optional().describe("New all-day date (YYYY-MM-DD)."),
        start: isoDateTime.optional().describe("New timed start (ISO)."),
        end: isoDateTime.optional().describe("New timed end (ISO)."),
        timeZone: z.string().optional(),
      },
    },
    async ({ id, date, start, end, timeZone }) => {
      try {
        if (!date && !start) {
          return errorResult("reschedule_task requires either `date` (all-day) or `start` (timed).");
        }
        const patch: UpdateEventPatch = date
          ? { start: date, end: addDaysToDateStr(date, 1), allDay: true }
          : { start: start!, end: end ?? start!, allDay: false, timeZone: timeZone ?? getTimeZone() };
        const item = await updateEvent(id,patch, getCalendarId());
        return jsonResult({ ok: true, task: item });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete Task",
      description:
        "Delete a task. Propagates to Google. Passing a recurring INSTANCE id deletes just that " +
        "occurrence; passing a series master id deletes the whole series (see delete_recurring for explicit scope).",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async ({ id }) => {
      try {
        await cancelEvent(id, getCalendarId());
        return jsonResult({ ok: true, deletedId: id });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
