/**
 * Persistent sync settings (T23) — which Google calendars to sync.
 *
 * Stored in Firestore at `settings/sync` so the selection survives restarts and
 * redeploys. Seeded once from the connected account's calendar list (via Composio),
 * defaulting to **primary-only** enabled. Reads are cheap (a single Firestore get,
 * no Composio call, no write) so they're safe on the hot path; the live calendar
 * list is only re-fetched by the explicit `refreshCalendars()` (the
 * `list_google_calendars` tool). Toggles are transactional to avoid clobber.
 */
import { getDb } from "../calendar/firestore";
import { Timestamp } from "@google-cloud/firestore";
import { gcalListCalendars, isSyncConfigured } from "./composio";

export interface SyncCalendar {
  googleCalendarId: string;
  summary?: string;
  primary?: boolean;
  accessRole?: string;
  enabled: boolean;
}

export interface SyncSettings {
  calendars: SyncCalendar[];
  updatedAt?: string;
}

function settingsRef() {
  return getDb().collection("settings").doc("sync");
}

/**
 * Read the sync settings (cheap: one Firestore get). Seeds once from the live
 * calendar list only if the doc doesn't exist yet and sync is configured.
 */
export async function getSyncSettings(): Promise<SyncSettings> {
  const snap = await settingsRef().get();
  if (snap.exists) return snap.data() as SyncSettings;
  if (!isSyncConfigured()) return { calendars: [] };
  return refreshCalendars();
}

/**
 * Fetch the live Google calendar list, merge it into the persisted settings
 * (preserving existing enable flags; new calendars default to enabled=primary),
 * and write it back. Call this explicitly to pick up newly-added calendars —
 * NOT on the hot path.
 */
export async function refreshCalendars(): Promise<SyncSettings> {
  const ref = settingsRef();
  if (!isSyncConfigured()) {
    const snap = await ref.get();
    return snap.exists ? (snap.data() as SyncSettings) : { calendars: [] };
  }
  let live;
  try {
    live = await gcalListCalendars();
  } catch {
    const snap = await ref.get();
    return snap.exists ? (snap.data() as SyncSettings) : { calendars: [] };
  }
  const snap = await ref.get();
  const existing: SyncCalendar[] = snap.exists ? ((snap.data() as SyncSettings).calendars ?? []) : [];
  const byId = new Map(existing.map((c) => [c.googleCalendarId, c]));
  const merged: SyncCalendar[] = live.map((c) => {
    const prev = byId.get(c.id);
    return {
      googleCalendarId: c.id,
      summary: c.summary,
      primary: c.primary ?? false,
      accessRole: c.accessRole,
      enabled: prev ? prev.enabled : Boolean(c.primary),
    };
  });
  const settings: SyncSettings = { calendars: merged, updatedAt: Timestamp.now().toDate().toISOString() };
  await ref.set(settings);
  return settings;
}

/** Enable/disable sync for one Google calendar (transactional); returns the updated settings. */
export async function setCalendarSync(googleCalendarId: string, enabled: boolean): Promise<SyncSettings> {
  const db = getDb();
  const ref = settingsRef();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const settings: SyncSettings = snap.exists ? (snap.data() as SyncSettings) : { calendars: [] };
    const cal = settings.calendars.find((c) => c.googleCalendarId === googleCalendarId);
    if (!cal) throw new Error(`Unknown Google calendar: ${googleCalendarId}`);
    cal.enabled = enabled;
    settings.updatedAt = Timestamp.now().toDate().toISOString();
    tx.set(ref, settings);
    return settings;
  });
}

/** Google calendar ids currently enabled for sync. */
export async function enabledCalendarIds(): Promise<string[]> {
  const s = await getSyncSettings();
  return s.calendars.filter((c) => c.enabled).map((c) => c.googleCalendarId);
}

/** Whether a specific Google calendar is enabled for sync. */
export async function isCalendarEnabled(googleCalendarId: string): Promise<boolean> {
  const s = await getSyncSettings();
  return s.calendars.some((c) => c.googleCalendarId === googleCalendarId && c.enabled);
}

/**
 * The Google calendar that MCP-created events mirror OUT to, or **null** when no
 * calendar is enabled (outbound then no-ops). Prefer the enabled primary, else the
 * first enabled owner-access calendar, else any enabled calendar.
 */
export async function outboundCalendarId(): Promise<string | null> {
  const s = await getSyncSettings();
  const primary = s.calendars.find((c) => c.primary && c.enabled);
  if (primary) return primary.googleCalendarId;
  const owner = s.calendars.find((c) => c.enabled && c.accessRole === "owner");
  if (owner) return owner.googleCalendarId;
  return s.calendars.find((c) => c.enabled)?.googleCalendarId ?? null;
}
