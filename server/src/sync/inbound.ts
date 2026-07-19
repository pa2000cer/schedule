/**
 * Inbound sync (T23): import Google Calendar events INTO Firestore.
 *
 * **Firestore always wins.** Inbound only IMPORTS Google events that don't yet
 * exist in Firestore (matched by `googleEventId`); it never overwrites an existing
 * Firestore doc from Google. Events created directly in Google are pulled in once;
 * thereafter Firestore is authoritative and edits should be made in the app (they
 * mirror back out to the right Google calendar via the stored `googleCalendarId`).
 *
 * Only calendars enabled in `settings/sync` are pulled. Recurring events are
 * imported as MASTERS (`singleEvents:false`) so the store's own expander drives
 * the day view.
 */
import { gcalListEvents, isSyncConfigured } from "./composio";
import { enabledCalendarIds } from "./settings";
import { insertImportedEvent, findByGoogleEventId, zonedWallClock } from "../calendar/calendar";
import { getCalendarId, getTimeZone } from "../mcp/tools/context";

export interface SyncResult {
  imported: number;
  skipped: number;
  calendars: number;
}

/** Import new Google events (from enabled calendars) into Firestore. */
export async function importFromGoogle(opts?: { timeMin?: string; timeMax?: string; updatedMin?: string }): Promise<SyncResult> {
  if (!isSyncConfigured()) return { imported: 0, skipped: 0, calendars: 0 };
  // Use the same internal Firestore calendar the store writes to, so outbound-mirrored
  // events are correctly recognized here (no cross-calendar duplicate — BUG 1 fix).
  const internalCalendarId = getCalendarId();
  const userZone = getTimeZone();
  const calIds = await enabledCalendarIds();
  const nowMs = new Date().getTime();
  const timeMin = opts?.timeMin ?? new Date(nowMs - 30 * 86400000).toISOString();
  const timeMax = opts?.timeMax ?? new Date(nowMs + 180 * 86400000).toISOString();

  let imported = 0;
  let skipped = 0;
  for (const gcalId of calIds) {
    let events;
    try {
      events = await gcalListEvents(gcalId, { timeMin, timeMax, updatedMin: opts?.updatedMin, singleEvents: false });
    } catch (err) {
      console.error(`[sync] listEvents failed for ${gcalId}:`, err instanceof Error ? err.message : err);
      continue;
    }
    for (const ev of events) {
      if (!ev.id || ev.status === "cancelled") continue;
      if (await findByGoogleEventId(ev.id, internalCalendarId)) {
        skipped += 1;
        continue; // Firestore already owns it — Firestore wins.
      }
      const allDay = Boolean(ev.start?.date && !ev.start?.dateTime);
      let start: string;
      let end: string;
      if (allDay) {
        start = ev.start!.date!;
        end = ev.end?.date ?? ev.start!.date!;
      } else if (ev.start?.dateTime) {
        // Convert the offset-aware Google instant into the user's local wall-clock,
        // so startUtc (recomputed downstream from start + zone) is correct across
        // timezones (BUG 4 fix), not a mis-guessed zone.
        start = zonedWallClock(new Date(ev.start.dateTime), userZone);
        end = ev.end?.dateTime ? zonedWallClock(new Date(ev.end.dateTime), userZone) : start;
      } else {
        skipped += 1;
        continue;
      }
      await insertImportedEvent(
        {
          title: ev.summary ?? "(untitled)",
          start,
          end,
          allDay,
          timeZone: userZone,
          taskFlag: ev.transparency === "transparent",
          location: ev.location,
          notes: ev.description,
          recurrence: ev.recurrence ?? undefined,
        },
        ev.id,
        gcalId,
        internalCalendarId,
      );
      imported += 1;
    }
  }
  return { imported, skipped, calendars: calIds.length };
}

/** Two-way sync tick: outbound is already write-through, so this pulls Google in. */
export const syncNow = importFromGoogle;
