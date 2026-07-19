/**
 * Appointment CRUD tools (T7): `add_appointment`, `update_appointment`,
 * `delete_appointment`.
 *
 * An appointment is a **timed** Google Calendar event (opaque/"busy"). These
 * wrap the T5 `createEvent`/`updateEvent`/`cancelEvent` helpers with
 * `task: false` and validated timed start/end. Deletes propagate to Google.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createEvent, updateEvent, cancelEvent } from "../../calendar/calendar";
import { getCalendarId, getTimeZone, jsonResult, errorResult } from "./context";

const isoDateTime = z
  .string()
  .describe("ISO 8601 datetime with offset, e.g. 2026-07-18T14:00:00-04:00.");

export function registerAppointmentTools(server: McpServer): void {
  server.registerTool(
    "add_appointment",
    {
      title: "Add Appointment",
      description: "Create a timed Google Calendar appointment. Returns the created item.",
      inputSchema: {
        title: z.string().min(1).describe("Appointment title."),
        start: isoDateTime,
        end: isoDateTime.optional().describe("End datetime; defaults to start if omitted."),
        location: z.string().optional(),
        notes: z.string().optional(),
        timeZone: z.string().optional().describe("IANA tz for the times; defaults to app tz."),
      },
    },
    async ({ title, start, end, location, notes, timeZone }) => {
      try {
        const item = await createEvent(
          {
            title,
            start,
            end,
            location,
            notes,
            timeZone: timeZone ?? getTimeZone(),
            task: false,
          },
          getCalendarId(),
        );
        return jsonResult({ ok: true, appointment: item });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "update_appointment",
    {
      title: "Update Appointment",
      description: "Patch an existing appointment. Only provided fields change.",
      inputSchema: {
        id: z.string().min(1).describe("Google event id of the appointment."),
        title: z.string().min(1).optional(),
        start: isoDateTime.optional(),
        end: isoDateTime.optional(),
        location: z.string().optional(),
        notes: z.string().optional(),
        timeZone: z.string().optional(),
      },
    },
    async ({ id, title, start, end, location, notes, timeZone }) => {
      try {
        const item = await updateEvent(
          id,
          { title, start, end, location, notes, timeZone: timeZone ?? getTimeZone() },
          getCalendarId(),
        );
        return jsonResult({ ok: true, appointment: item });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "delete_appointment",
    {
      title: "Delete Appointment",
      description: "Delete an appointment. Propagates to Google Calendar.",
      inputSchema: {
        id: z.string().min(1).describe("Google event id of the appointment."),
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
