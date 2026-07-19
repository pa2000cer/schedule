/**
 * Outbound sync (T23): mirror Firestore writes OUT to Google Calendar via Composio.
 *
 * Called by the event store after a successful Firestore write. Best-effort: a
 * Google/Composio failure is logged and swallowed — it never fails the Firestore
 * operation (Firestore is the source of truth). No-op unless `isSyncConfigured()`.
 *
 * v1 scope: standalone events and recurring-series masters (recurrence[] passed
 * through). Per-occurrence overrides/EXDATEs are NOT individually mirrored yet
 * (they remain Firestore-authoritative); the series itself is mirrored.
 */
import { isSyncConfigured, gcalCreateEvent, gcalUpdateEvent, gcalDeleteEvent, type MirrorFields } from "./composio";
import { outboundCalendarId, isCalendarEnabled } from "./settings";

export type { MirrorFields };

/**
 * Mirror a newly-created Firestore event to Google. Returns the mapping, or
 * undefined when sync is off or no calendar is enabled (outbound no-op).
 */
export async function mirrorCreate(f: MirrorFields): Promise<{ googleEventId: string; googleCalendarId: string } | undefined> {
  if (!isSyncConfigured()) return undefined;
  try {
    const googleCalendarId = await outboundCalendarId();
    if (!googleCalendarId) return undefined; // no enabled calendar → don't mirror out
    const googleEventId = await gcalCreateEvent(googleCalendarId, f);
    return { googleEventId, googleCalendarId };
  } catch (err) {
    console.error("[sync] mirrorCreate failed:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Mirror an update to an already-linked Google event (best-effort; skips disabled calendars). */
export async function mirrorUpdate(googleCalendarId: string, googleEventId: string, f: MirrorFields): Promise<void> {
  if (!isSyncConfigured()) return;
  try {
    if (!(await isCalendarEnabled(googleCalendarId))) return;
    await gcalUpdateEvent(googleCalendarId, googleEventId, f);
  } catch (err) {
    console.error("[sync] mirrorUpdate failed:", err instanceof Error ? err.message : err);
  }
}

/** Mirror a delete of a linked Google event (best-effort; skips disabled calendars). */
export async function mirrorDelete(googleCalendarId: string, googleEventId: string): Promise<void> {
  if (!isSyncConfigured()) return;
  try {
    if (!(await isCalendarEnabled(googleCalendarId))) return;
    await gcalDeleteEvent(googleCalendarId, googleEventId);
  } catch (err) {
    console.error("[sync] mirrorDelete failed:", err instanceof Error ? err.message : err);
  }
}
