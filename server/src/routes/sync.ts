/**
 * Sync settings + manual-sync routes (T27) — the web UI's Settings panel.
 *
 *   GET  /api/sync/calendars           — connected Google calendars + on/off state
 *   POST /api/sync/calendar {id,enabled}— toggle sync for one calendar (persisted)
 *   POST /api/sync/now                  — pull Google → Firestore (Firestore wins)
 *
 * All behind the app-wide `requireAuth` guard. These call the sync modules
 * directly (server-side); Firestore is the source of truth, Google a Composio
 * mirror. When Composio isn't configured, endpoints report `configured:false`.
 */
import { Router, type Request, type Response } from "express";
import { isSyncConfigured } from "../sync/composio";
import { refreshCalendars, setCalendarSync } from "../sync/settings";
import { syncNow } from "../sync/inbound";

export const syncRouter = Router();

syncRouter.get("/api/sync/calendars", async (_req: Request, res: Response) => {
  try {
    if (!isSyncConfigured()) {
      res.status(200).json({ configured: false, calendars: [] });
      return;
    }
    const settings = await refreshCalendars();
    res.status(200).json({ configured: true, calendars: settings.calendars });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[sync] list calendars error:", err);
    res.status(502).json({ error: "sync_calendars_failed" });
  }
});

syncRouter.post("/api/sync/calendar", async (req: Request, res: Response) => {
  const googleCalendarId = req.body?.googleCalendarId;
  const enabled = req.body?.enabled;
  if (typeof googleCalendarId !== "string" || !googleCalendarId) {
    res.status(400).json({ error: "missing_calendar_id" });
    return;
  }
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "missing_enabled" });
    return;
  }
  try {
    if (!isSyncConfigured()) {
      res.status(400).json({ error: "sync_not_configured" });
      return;
    }
    const settings = await setCalendarSync(googleCalendarId, enabled);
    res.status(200).json({ ok: true, calendars: settings.calendars });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[sync] set calendar error:", err);
    res.status(502).json({ error: "sync_set_failed", detail: err instanceof Error ? err.message : undefined });
  }
});

syncRouter.post("/api/sync/now", async (_req: Request, res: Response) => {
  try {
    if (!isSyncConfigured()) {
      res.status(400).json({ error: "sync_not_configured" });
      return;
    }
    const result = await syncNow();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[sync] sync now error:", err);
    res.status(502).json({ error: "sync_now_failed" });
  }
});
