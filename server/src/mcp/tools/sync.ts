/**
 * Google Calendar sync tools (T23): `sync_now`, `list_google_calendars`,
 * `set_calendar_sync`.
 *
 * Firestore is the source of truth; these expose the two-way Composio mirror.
 * Outbound (Firestore→Google) is automatic write-through on every store mutation;
 * these tools drive the INBOUND pull and the persistent per-calendar settings.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonResult, errorResult } from "./context";
import { isSyncConfigured } from "../../sync/composio";
import { refreshCalendars, setCalendarSync } from "../../sync/settings";
import { syncNow } from "../../sync/inbound";

export function registerSyncTools(server: McpServer): void {
  server.registerTool(
    "list_google_calendars",
    {
      title: "List Google Calendars",
      description:
        "List the connected Google calendars and their sync on/off state (persisted in Firestore). " +
        "Use set_calendar_sync to toggle which calendars sync.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!isSyncConfigured()) return jsonResult({ configured: false, calendars: [] });
        const settings = await refreshCalendars();
        return jsonResult({ configured: true, calendars: settings.calendars });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "set_calendar_sync",
    {
      title: "Set Calendar Sync",
      description: "Enable or disable two-way sync for a specific Google calendar (persisted).",
      inputSchema: {
        googleCalendarId: z.string().min(1).describe("The Google calendar id (from list_google_calendars)."),
        enabled: z.boolean().describe("true to sync this calendar, false to stop."),
      },
    },
    async ({ googleCalendarId, enabled }) => {
      try {
        if (!isSyncConfigured()) return errorResult("Google Calendar sync is not configured (no Composio credentials).");
        const settings = await setCalendarSync(googleCalendarId, enabled);
        return jsonResult({ ok: true, calendars: settings.calendars });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "sync_now",
    {
      title: "Sync Now",
      description:
        "Pull events from the enabled Google calendars into Firestore (Firestore always wins on conflict). " +
        "Firestore→Google changes are mirrored automatically on every edit, so this drives the inbound direction.",
      inputSchema: {
        timeMin: z.string().optional().describe("ISO lower bound; default 30 days ago."),
        timeMax: z.string().optional().describe("ISO upper bound; default 180 days ahead."),
      },
    },
    async ({ timeMin, timeMax }) => {
      try {
        if (!isSyncConfigured()) return errorResult("Google Calendar sync is not configured (no Composio credentials).");
        const result = await syncNow({ timeMin, timeMax });
        return jsonResult({ ok: true, ...result });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
