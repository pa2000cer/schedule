/**
 * Composio HTTP wrapper for Google Calendar sync (T23).
 *
 * Firestore is the source of truth; Google Calendar is a two-way mirror reached
 * exclusively through **Composio** (no Google OAuth in our code). Direct HTTP to
 * `backend.composio.dev/api/v3` — never `claude -p` (1000× slower).
 *
 * Config comes from env (git-ignored `.env.local` locally, Secret Manager on
 * Cloud Run): `COMPOSIO_API_KEY` + `COMPOSIO_USER_ID`. When unset, `isSyncConfigured()`
 * is false and all sync is a no-op, so the app runs fine without Composio.
 */
const BASE = "https://backend.composio.dev/api/v3";

export function isSyncConfigured(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY && process.env.COMPOSIO_USER_ID);
}

/** Execute a Composio tool by slug; returns the unwrapped `data` (throws on error). */
export async function composioExecute(slug: string, args: Record<string, unknown>): Promise<any> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  const userId = process.env.COMPOSIO_USER_ID;
  if (!apiKey || !userId) throw new Error("Composio not configured (COMPOSIO_API_KEY / COMPOSIO_USER_ID).");
  const res = await fetch(`${BASE}/tools/execute/${encodeURIComponent(slug)}`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, arguments: args }),
  });
  const json = (await res.json()) as { data?: any; error?: { message?: string } | null };
  if (json.error) throw new Error(`Composio ${slug}: ${json.error.message ?? "unknown error"}`);
  // Google Calendar tool payloads are nested under data.response_data.
  return json.data?.response_data ?? json.data ?? {};
}

// ---------------------------------------------------------------------------
// Google Calendar helpers
// ---------------------------------------------------------------------------

export interface GcalCalendar {
  id: string;
  summary?: string;
  primary?: boolean;
  accessRole?: string;
}

export async function gcalListCalendars(): Promise<GcalCalendar[]> {
  const data = await composioExecute("GOOGLECALENDAR_LIST_CALENDARS", {});
  const items = data.items ?? data.calendars ?? [];
  return items.map((c: any) => ({ id: c.id, summary: c.summary, primary: c.primary, accessRole: c.accessRole }));
}

export interface GcalEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
}

export async function gcalListEvents(
  calendarId: string,
  opts: { timeMin?: string; timeMax?: string; updatedMin?: string; singleEvents?: boolean; maxResults?: number } = {},
): Promise<GcalEvent[]> {
  const data = await composioExecute("GOOGLECALENDAR_EVENTS_LIST", {
    calendarId,
    ...(opts.timeMin ? { timeMin: opts.timeMin } : {}),
    ...(opts.timeMax ? { timeMax: opts.timeMax } : {}),
    ...(opts.updatedMin ? { updatedMin: opts.updatedMin } : {}),
    ...(opts.singleEvents !== undefined ? { singleEvents: opts.singleEvents } : {}),
    maxResults: opts.maxResults ?? 250,
  });
  return (data.items ?? data.events ?? []) as GcalEvent[];
}

/** Fields the store hands to the mirror (a subset of EventDoc — no type coupling). */
export interface MirrorFields {
  title: string;
  /** wall-clock: "YYYY-MM-DDTHH:MM:SS" (timed) or "YYYY-MM-DD" (all-day). */
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
  taskFlag: boolean;
  location?: string;
  notes?: string;
  recurrence?: string[] | null;
}

/** Build Composio CREATE/UPDATE args (start_datetime + duration model) from mirror fields. */
export function mirrorToGcalArgs(calendarId: string, f: MirrorFields): Record<string, unknown> {
  const startDateTime = f.allDay ? `${f.start}T00:00:00` : f.start;
  const { hours, minutes } = durationHM(f);
  const args: Record<string, unknown> = {
    calendar_id: calendarId,
    summary: f.title,
    start_datetime: startDateTime,
    event_duration_hour: hours,
    event_duration_minutes: minutes,
    timezone: f.timeZone,
    transparency: f.taskFlag ? "transparent" : "opaque",
  };
  if (f.location) args.location = f.location;
  if (f.notes) args.description = f.notes;
  if (f.recurrence && f.recurrence.length > 0) args.recurrence = f.recurrence;
  return args;
}

/** Duration (hours 0-24, minutes 0-59) between start and end wall-clock strings. */
function durationHM(f: MirrorFields): { hours: number; minutes: number } {
  if (f.allDay) {
    // Approximate an all-day event as 24h (Composio has no native all-day flag).
    return { hours: 24, minutes: 0 };
  }
  const ms = wallClockMs(f.end) - wallClockMs(f.start);
  if (!(ms > 0)) return { hours: 1, minutes: 0 };
  let totalMin = Math.round(ms / 60000);
  if (totalMin < 1) totalMin = 1; // sub-minute span → never send {0,0}
  let hours = Math.floor(totalMin / 60);
  let minutes = totalMin % 60;
  if (hours > 24) {
    // Composio's duration model caps at 24h; longer spans are truncated (lossy).
    hours = 24;
    minutes = 0;
  }
  return { hours, minutes };
}

/** Naive wall-clock ms (offset-agnostic; only used for a start/end delta). */
function wallClockMs(local: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(local);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

export async function gcalCreateEvent(calendarId: string, f: MirrorFields): Promise<string> {
  const data = await composioExecute("GOOGLECALENDAR_CREATE_EVENT", mirrorToGcalArgs(calendarId, f));
  const id = data.id ?? data.event?.id;
  if (!id) throw new Error("gcalCreateEvent: no event id in response");
  return id as string;
}

export async function gcalUpdateEvent(calendarId: string, googleEventId: string, f: MirrorFields): Promise<void> {
  await composioExecute("GOOGLECALENDAR_UPDATE_EVENT", {
    ...mirrorToGcalArgs(calendarId, f),
    event_id: googleEventId,
  });
}

export async function gcalDeleteEvent(calendarId: string, googleEventId: string): Promise<void> {
  await composioExecute("GOOGLECALENDAR_DELETE_EVENT", { calendar_id: calendarId, event_id: googleEventId });
}
