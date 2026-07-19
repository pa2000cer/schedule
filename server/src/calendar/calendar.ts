/**
 * Event store (T19) — Firestore-backed.
 *
 * Replaces the former Google Calendar backing. All events/tasks live in
 * **Firestore** (single source of truth); Google Calendar is a separate two-way
 * mirror handled by the sync layer (T23), never read here. No Google auth is
 * required for any operation — the Firestore client uses ADC (see `./firestore`).
 *
 * The public surface is unchanged from the Google-backed version EXCEPT that the
 * operations no longer take an `auth` client:
 *   listDayEvents(date, calendarId?, timeZone?)
 *   createEvent(input, calendarId?)
 *   updateEvent(id, patch, calendarId?)
 *   cancelEvent(id, calendarId?)
 *   getEvent(id, calendarId?)
 *   listEventInstances(id, opts?, calendarId?)
 * The normalized `CalendarItem` shape and all pure helpers (`buildRRule`,
 * `todayInTimeZone`, `dayRangeUtc`, `localMidnightUtc`, `addDaysToDateStr`,
 * `DEFAULT_TIME_ZONE`, `RecurrenceSpec`) are preserved so every tool, route, and
 * the frontend keep working byte-for-byte.
 *
 * ## Data model — `calendars/{calendarId}/events/{eventId}`
 * One doc per standalone event OR per recurring series master:
 *   title, kind, taskFlag, allDay, start, end (dual-mode strings), timeZone,
 *   location?, notes?, done (task), startUtc/endUtc (Timestamps — the only range
 *   key), isMaster, recurrence (RRULE lines), exdates[], overrides{key→{...}},
 *   googleEventId? (sync mapping), createdAt/updatedAt.
 *
 * ## Recurrence
 * Authored as `RecurrenceSpec` → `buildRRule()` (RRULE lines) stored on a master.
 * Instances are expanded **in local wall-clock** here (no `rrule` dep), with
 * synthetic ids `masterId_YYYYMMDDTHHMMSSZ` (all-day: `masterId_YYYYMMDD`),
 * mirroring the old Google instance ids. `exdates` skip an occurrence; per-instance
 * `overrides` adjust one. Instance-vs-master identity is resolved inside the store
 * (`splitInstanceId`), so `updateEvent`/`cancelEvent` on an instance id record an
 * override / EXDATE automatically — the task tools need no logic change.
 *
 * ## Timezone handling
 * Same `Intl.DateTimeFormat` offset trick as before (no tz-data dependency):
 * `localWallClockToUtc` converges on the correct offset (DST-correct) for any
 * local wall-clock instant; wall-clock `start`/`end` strings are stored and
 * returned verbatim so display never depends on server/browser zone.
 */
import { getDb } from "./firestore";
import { Timestamp, type Firestore } from "@google-cloud/firestore";
import { mirrorCreate, mirrorUpdate, mirrorDelete, type MirrorFields } from "../sync/outbound";

/** Default IANA timezone used when no explicit timezone is supplied. */
export const DEFAULT_TIME_ZONE = process.env.APP_TIMEZONE || "America/New_York";

// ---------------------------------------------------------------------------
// Normalized item shape (unchanged contract; source is now "firestore")
// ---------------------------------------------------------------------------

export type CalendarItemKind = "appointment" | "task";

/** Normalized event shape so downstream consumers (T7/T12) don't touch storage objects. */
export interface CalendarItem {
  id: string;
  kind: CalendarItemKind;
  title: string;
  /** ISO 8601 datetime (timed events) or YYYY-MM-DD (all-day events). */
  start?: string;
  /** ISO 8601 datetime (timed events) or YYYY-MM-DD (all-day events, exclusive). */
  end?: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  /** Task done-state. Only meaningful for `kind === "task"` (undefined for appointments). */
  done?: boolean;
  /** True if this item participates in a recurring series (master or expanded instance). */
  recurring?: boolean;
  /** For an expanded recurring INSTANCE, the id of its series master event. */
  recurringEventId?: string;
  /** RRULE lines present on a recurring series MASTER (absent on instances). */
  recurrence?: string[];
  source: "firestore";
  /** The stored Firestore document (opaque), for callers that need extra fields (e.g. googleEventId). */
  raw?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stored document shape
// ---------------------------------------------------------------------------

interface OverrideDoc {
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  notes?: string;
  done?: boolean;
  cancelled?: boolean;
}

interface EventDoc {
  calendarId: string;
  title: string;
  kind: CalendarItemKind;
  taskFlag: boolean;
  allDay: boolean;
  start: string;
  end: string;
  timeZone: string;
  location?: string;
  notes?: string;
  done: boolean;
  startUtc: Timestamp;
  endUtc: Timestamp;
  isMaster: boolean;
  recurrence: string[] | null;
  exdates: string[];
  overrides: Record<string, OverrideDoc>;
  /** Google Calendar event id + calendar id, set by the sync layer (T23); undefined until mirrored. */
  googleEventId?: string;
  googleCalendarId?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Extract the outbound-mirror fields from a stored doc. */
function mirrorFieldsFromDoc(doc: EventDoc): MirrorFields {
  return {
    title: doc.title,
    start: doc.start,
    end: doc.end,
    allDay: doc.allDay,
    timeZone: doc.timeZone,
    taskFlag: doc.taskFlag,
    location: doc.location,
    notes: doc.notes,
    recurrence: doc.recurrence,
  };
}

/** Kind from the task/all-day signals (replaces the old Google `classify`). */
export function classifyKind(taskFlag: boolean, allDay: boolean): CalendarItemKind {
  return taskFlag || allDay ? "task" : "appointment";
}

// ---------------------------------------------------------------------------
// Timezone-aware conversions (Intl-based, no tz-data dependency)
// ---------------------------------------------------------------------------

function tzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return (asUtc - date.getTime()) / 60000;
}

function parseDateStr(dateStr: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) throw new Error(`Invalid date string (expected YYYY-MM-DD): ${dateStr}`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** Split a local wall-clock ISO ("YYYY-MM-DDTHH:MM[:SS]") into naive UTC parts. */
function parseLocalWallClock(localIso: string): {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(localIso);
  if (!match) throw new Error(`Invalid local datetime (expected YYYY-MM-DDTHH:MM): ${localIso}`);
  return {
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
    hh: Number(match[4]),
    mm: Number(match[5]),
    ss: match[6] ? Number(match[6]) : 0,
  };
}

/**
 * The UTC instant of a local wall-clock datetime in `timeZone`. Converges via one
 * iteration to handle DST transitions near the target instant.
 */
export function localWallClockToUtc(localIso: string, timeZone: string): Date {
  const { y, m, d, hh, mm, ss } = parseLocalWallClock(localIso);
  const naiveUtcGuess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const offset1 = tzOffsetMinutes(new Date(naiveUtcGuess), timeZone);
  const refined = naiveUtcGuess - offset1 * 60000;
  const offset2 = tzOffsetMinutes(new Date(refined), timeZone);
  return new Date(naiveUtcGuess - offset2 * 60000);
}

/** The UTC instant of local midnight for `dateStr` (YYYY-MM-DD) in `timeZone`. */
export function localMidnightUtc(dateStr: string, timeZone: string): Date {
  return localWallClockToUtc(`${dateStr}T00:00:00`, timeZone);
}

/** Add `days` (may be negative) to a `YYYY-MM-DD` date string. */
export function addDaysToDateStr(dateStr: string, days: number): string {
  const { y, m, d } = parseDateStr(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Whole-day difference `a - b` for two YYYY-MM-DD strings. */
function dateDiffDays(a: string, b: string): number {
  const pa = parseDateStr(a);
  const pb = parseDateStr(b);
  return Math.round((Date.UTC(pa.y, pa.m - 1, pa.d) - Date.UTC(pb.y, pb.m - 1, pb.d)) / 86400000);
}

/** Today's date (YYYY-MM-DD) as observed in `timeZone`. */
export function todayInTimeZone(timeZone: string = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** timeMin/timeMax (RFC3339 UTC) spanning local midnight-to-midnight of `dateStr`. */
export function dayRangeUtc(
  dateStr: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): { timeMin: string; timeMax: string } {
  const timeMin = localMidnightUtc(dateStr, timeZone).toISOString();
  const timeMax = localMidnightUtc(addDaysToDateStr(dateStr, 1), timeZone).toISOString();
  return { timeMin, timeMax };
}

// ---------------------------------------------------------------------------
// RRULE construction & parsing
// ---------------------------------------------------------------------------

export interface RecurrenceSpec {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval?: number;
  byDay?: Array<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU">;
  count?: number;
  /** Last date (inclusive), `YYYY-MM-DD`; serialized as UTC `...T235959Z`. */
  until?: string;
}

function formatUntil(until: string): string {
  const digits = until.replace(/[^\dTZ]/gi, "");
  if (/^\d{8}$/.test(digits)) return `${digits}T235959Z`;
  const d = new Date(until);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid UNTIL date: ${until}`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Build a single RFC-5545 `RRULE:` line from a `RecurrenceSpec`. Pure/testable. */
export function buildRRule(spec: RecurrenceSpec): string[] {
  if (spec.count && spec.until) {
    throw new Error("RecurrenceSpec: `count` and `until` are mutually exclusive.");
  }
  const parts = [`FREQ=${spec.freq}`];
  if (spec.interval && spec.interval > 1) parts.push(`INTERVAL=${spec.interval}`);
  if (spec.byDay && spec.byDay.length > 0) parts.push(`BYDAY=${spec.byDay.join(",")}`);
  if (spec.count && spec.count > 0) parts.push(`COUNT=${spec.count}`);
  if (spec.until) parts.push(`UNTIL=${formatUntil(spec.until)}`);
  return [`RRULE:${parts.join(";")}`];
}

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

interface ParsedRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byDay: string[];
  count?: number;
  untilDate?: string; // YYYY-MM-DD (inclusive)
}

/** Parse the first RRULE line from a recurrence[] into a ParsedRule. */
function parseRRule(recurrence: string[]): ParsedRule | null {
  const line = recurrence.find((l) => /^RRULE:/i.test(l));
  if (!line) return null;
  const body = line.replace(/^RRULE:/i, "");
  const kv: Record<string, string> = {};
  for (const pair of body.split(";")) {
    const [k, v] = pair.split("=");
    if (k && v) kv[k.toUpperCase()] = v;
  }
  const freq = (kv.FREQ as ParsedRule["freq"]) || "DAILY";
  const interval = kv.INTERVAL ? Math.max(1, parseInt(kv.INTERVAL, 10)) : 1;
  const byDay = kv.BYDAY ? kv.BYDAY.split(",").map((s) => s.trim().toUpperCase()) : [];
  const count = kv.COUNT ? parseInt(kv.COUNT, 10) : undefined;
  let untilDate: string | undefined;
  if (kv.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(kv.UNTIL);
    if (m) untilDate = `${m[1]}-${m[2]}-${m[3]}`;
  }
  return { freq, interval, byDay, count, untilDate };
}

const SAFETY_CAP = 4000;

/**
 * Enumerate occurrence START dates (YYYY-MM-DD) of a rule, chronologically, from
 * the seed. Bounded by COUNT / UNTIL, an exclusive `hardMaxDate`, and a safety cap.
 * COUNT is counted from the series' first occurrence (the seed).
 */
function enumerateOccurrenceDates(rule: ParsedRule, seedDateStr: string, hardMaxDate: string): string[] {
  const out: string[] = [];
  let produced = 0;
  const pushIfInBounds = (dateStr: string): boolean => {
    // returns false to signal termination
    if (rule.untilDate && dateDiffDays(dateStr, rule.untilDate) > 0) return false;
    if (dateDiffDays(dateStr, hardMaxDate) >= 0) return false;
    out.push(dateStr);
    produced += 1;
    if (rule.count && produced >= rule.count) return false;
    return true;
  };

  const seed = parseDateStr(seedDateStr);
  if (rule.freq === "DAILY") {
    for (let n = 0; n < SAFETY_CAP; n++) {
      const dateStr = addDaysToDateStr(seedDateStr, n * rule.interval);
      if (!pushIfInBounds(dateStr)) break;
      if (rule.untilDate == null && rule.count == null && dateDiffDays(dateStr, hardMaxDate) >= 0) break;
    }
  } else if (rule.freq === "WEEKLY") {
    const seedDow = new Date(Date.UTC(seed.y, seed.m - 1, seed.d)).getUTCDay(); // 0=Sun..6=Sat
    const days = rule.byDay.length > 0 ? rule.byDay : [WEEKDAY_CODES[seedDow]];
    // Offsets from Monday (RFC 5545 default WKST=MO): MO=0 … SU=6.
    const offsets = days
      .map((c) => WEEKDAY_CODES.indexOf(c as (typeof WEEKDAY_CODES)[number]))
      .filter((i) => i >= 0)
      .map((wIdx) => (wIdx + 6) % 7)
      .sort((a, b) => a - b);
    const daysFromMonday = (seedDow + 6) % 7;
    const weekStart = addDaysToDateStr(seedDateStr, -daysFromMonday); // Monday of the seed's week
    let terminated = false;
    for (let w = 0; w < SAFETY_CAP && !terminated; w++) {
      const blockStart = addDaysToDateStr(weekStart, w * rule.interval * 7);
      if (dateDiffDays(blockStart, hardMaxDate) >= 7 && rule.count == null && rule.untilDate == null) break;
      let anyThisBlockBeforeMax = false;
      for (const off of offsets) {
        const dateStr = addDaysToDateStr(blockStart, off);
        if (dateDiffDays(dateStr, seedDateStr) < 0) continue; // before series start
        if (dateDiffDays(dateStr, hardMaxDate) < 0) anyThisBlockBeforeMax = true;
        if (!pushIfInBounds(dateStr)) {
          terminated = true;
          break;
        }
      }
      if (!anyThisBlockBeforeMax && rule.count == null && rule.untilDate == null) break;
    }
  } else if (rule.freq === "MONTHLY") {
    for (let n = 0; n < SAFETY_CAP; n++) {
      const monthIndex = seed.m - 1 + n * rule.interval;
      const y = seed.y + Math.floor(monthIndex / 12);
      const m = (monthIndex % 12) + 1;
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      if (seed.d > daysInMonth) continue; // skip invalid (e.g. 31st in short months)
      const dateStr = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(seed.d).padStart(2, "0")}`;
      if (!pushIfInBounds(dateStr)) break;
      if (rule.untilDate == null && rule.count == null && dateDiffDays(dateStr, hardMaxDate) >= 0) break;
    }
  } else {
    // YEARLY
    for (let n = 0; n < SAFETY_CAP; n++) {
      const y = seed.y + n * rule.interval;
      const daysInMonth = new Date(Date.UTC(y, seed.m, 0)).getUTCDate();
      if (seed.d > daysInMonth) continue; // Feb 29 in a non-leap year
      const dateStr = `${String(y).padStart(4, "0")}-${String(seed.m).padStart(2, "0")}-${String(seed.d).padStart(2, "0")}`;
      if (!pushIfInBounds(dateStr)) break;
      if (rule.untilDate == null && rule.count == null && dateDiffDays(dateStr, hardMaxDate) >= 0) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Instance-id handling
// ---------------------------------------------------------------------------

const INSTANCE_SUFFIX_RE = /^(.*)_(\d{8}(?:T\d{6}Z)?)$/;

/** Split `masterId_YYYYMMDD[THHMMSSZ]` into { masterId, instanceKey }, or null if not an instance id. */
export function splitInstanceId(id: string): { masterId: string; instanceKey: string } | null {
  const m = INSTANCE_SUFFIX_RE.exec(id);
  if (!m) return null;
  return { masterId: m[1], instanceKey: m[2] };
}

/** Basic-format UTC key `YYYYMMDDTHHMMSSZ` for a Date. */
function basicUtcKey(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Doc <-> CalendarItem mapping
// ---------------------------------------------------------------------------

function docToItem(id: string, doc: EventDoc): CalendarItem {
  return {
    id,
    kind: doc.kind,
    title: doc.title,
    start: doc.start,
    end: doc.end,
    allDay: doc.allDay,
    location: doc.location,
    notes: doc.notes,
    done: doc.kind === "task" ? doc.done : undefined,
    recurring: doc.isMaster,
    recurringEventId: undefined,
    recurrence: doc.isMaster && doc.recurrence ? doc.recurrence : undefined,
    source: "firestore",
    raw: { ...doc, googleEventId: doc.googleEventId },
  };
}

// ---------------------------------------------------------------------------
// Firestore helpers
// ---------------------------------------------------------------------------

function eventsCol(db: Firestore, calendarId: string) {
  return db.collection("calendars").doc(calendarId).collection("events");
}

function computeUtc(start: string, end: string, allDay: boolean, timeZone: string): { startUtc: Date; endUtc: Date } {
  if (allDay) {
    return { startUtc: localMidnightUtc(start, timeZone), endUtc: localMidnightUtc(end, timeZone) };
  }
  return { startUtc: localWallClockToUtc(start, timeZone), endUtc: localWallClockToUtc(end, timeZone) };
}

// ---------------------------------------------------------------------------
// Public store operations (no auth param)
// ---------------------------------------------------------------------------

export interface CreateEventInput {
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  notes?: string;
  /** IANA timezone for timed events; defaults to DEFAULT_TIME_ZONE. Ignored for all-day. */
  timeZone?: string;
  /** Mark this as a task-style entry. */
  task?: boolean;
  /** RRULE lines making this a recurring series. */
  recurrence?: string[];
  /** Task done-state. */
  status?: "done" | "todo";
}

/** Create a new event/task/recurring-master document. */
export async function createEvent(input: CreateEventInput, calendarId = "primary"): Promise<CalendarItem> {
  const db = getDb();
  const timeZone = input.timeZone || DEFAULT_TIME_ZONE;
  const allDay = Boolean(input.allDay);
  const start = input.start;
  const end = input.end ?? input.start;
  const taskFlag = Boolean(input.task);
  const kind = classifyKind(taskFlag, allDay);
  const { startUtc, endUtc } = computeUtc(start, end, allDay, timeZone);
  const now = Timestamp.now();
  const isMaster = Boolean(input.recurrence && input.recurrence.length > 0);

  const doc: EventDoc = {
    calendarId,
    title: input.title,
    kind,
    taskFlag,
    allDay,
    start,
    end,
    timeZone,
    location: input.location,
    notes: input.notes,
    done: input.status === "done",
    startUtc: Timestamp.fromDate(startUtc),
    endUtc: Timestamp.fromDate(endUtc),
    isMaster,
    recurrence: isMaster ? input.recurrence! : null,
    exdates: [],
    overrides: {},
    createdAt: now,
    updatedAt: now,
  };
  // Strip undefined (Firestore rejects undefined field values).
  const clean = stripUndefined(doc);
  const ref = eventsCol(db, calendarId).doc();
  await ref.set(clean);

  // Outbound mirror to Google (best-effort; no-op unless sync configured).
  const mapping = await mirrorCreate(mirrorFieldsFromDoc(doc));
  if (mapping) {
    doc.googleEventId = mapping.googleEventId;
    doc.googleCalendarId = mapping.googleCalendarId;
    try {
      await ref.update({ googleEventId: mapping.googleEventId, googleCalendarId: mapping.googleCalendarId });
    } catch (e) {
      console.error("[sync] googleEventId write-back failed:", e instanceof Error ? e.message : e);
    }
  }
  return docToItem(ref.id, doc);
}

/** Fields for importing a Google event into Firestore (inbound sync). */
export interface ImportedEventInput {
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  timeZone?: string;
  taskFlag?: boolean;
  location?: string;
  notes?: string;
  recurrence?: string[];
  status?: "done" | "todo";
}

/** True if a doc already maps to this Google event id (inbound idempotency). */
export async function findByGoogleEventId(googleEventId: string, calendarId = "primary"): Promise<boolean> {
  const snap = await eventsCol(getDb(), calendarId).where("googleEventId", "==", googleEventId).limit(1).get();
  return !snap.empty;
}

/**
 * Insert a Firestore event imported FROM Google (inbound sync). Sets the
 * google mapping and does NOT mirror back out (avoids an echo loop).
 */
export async function insertImportedEvent(
  f: ImportedEventInput,
  googleEventId: string,
  googleCalendarId: string,
  calendarId = "primary",
): Promise<string> {
  const db = getDb();
  const timeZone = f.timeZone || DEFAULT_TIME_ZONE;
  const allDay = Boolean(f.allDay);
  const start = f.start;
  const end = f.end ?? f.start;
  const taskFlag = Boolean(f.taskFlag);
  const kind = classifyKind(taskFlag, allDay);
  const { startUtc, endUtc } = computeUtc(start, end, allDay, timeZone);
  const now = Timestamp.now();
  const isMaster = Boolean(f.recurrence && f.recurrence.length > 0);
  const doc: EventDoc = {
    calendarId,
    title: f.title,
    kind,
    taskFlag,
    allDay,
    start,
    end,
    timeZone,
    location: f.location,
    notes: f.notes,
    done: f.status === "done",
    startUtc: Timestamp.fromDate(startUtc),
    endUtc: Timestamp.fromDate(endUtc),
    isMaster,
    recurrence: isMaster ? f.recurrence! : null,
    exdates: [],
    overrides: {},
    googleEventId,
    googleCalendarId,
    createdAt: now,
    updatedAt: now,
  };
  const ref = eventsCol(db, calendarId).doc();
  await ref.set(stripUndefined(doc));
  return ref.id;
}

export interface UpdateEventPatch {
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  notes?: string;
  timeZone?: string;
  task?: boolean;
  /** Replace the recurrence rule set on a series master. */
  recurrence?: string[];
  /** Set task done-state. */
  status?: "done" | "todo";
}

/**
 * Patch an existing event. If `id` is a recurring INSTANCE id, the patch is
 * recorded as a per-occurrence override on the master; otherwise the doc is patched.
 */
export async function updateEvent(id: string, patch: UpdateEventPatch, calendarId = "primary"): Promise<CalendarItem> {
  const db = getDb();
  const col = eventsCol(db, calendarId);

  const instance = splitInstanceId(id);
  if (instance) {
    // Per-occurrence override on the master.
    const masterRef = col.doc(instance.masterId);
    const snap = await masterRef.get();
    if (!snap.exists) throw new Error(`Recurring master not found: ${instance.masterId}`);
    const master = snap.data() as EventDoc;
    const override: OverrideDoc = { ...(master.overrides?.[instance.instanceKey] ?? {}) };
    if (patch.title !== undefined) override.title = patch.title;
    if (patch.start !== undefined) override.start = patch.start;
    if (patch.end !== undefined) override.end = patch.end;
    if (patch.location !== undefined) override.location = patch.location;
    if (patch.notes !== undefined) override.notes = patch.notes;
    if (patch.status !== undefined) override.done = patch.status === "done";
    await masterRef.update({
      [`overrides.${instance.instanceKey}`]: stripUndefined(override),
      updatedAt: Timestamp.now(),
    });
    const fresh = (await masterRef.get()).data() as EventDoc;
    return buildInstanceItem(instance.masterId, fresh, instance.instanceKey);
  }

  const ref = col.doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Event not found: ${id}`);
  const cur = snap.data() as EventDoc;

  const next: EventDoc = { ...cur };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.location !== undefined) next.location = patch.location;
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.task !== undefined) next.taskFlag = patch.task;
  if (patch.timeZone !== undefined) next.timeZone = patch.timeZone;
  if (patch.allDay !== undefined) next.allDay = patch.allDay;
  if (patch.start !== undefined) next.start = patch.start;
  if (patch.end !== undefined) next.end = patch.end;
  if (patch.status !== undefined) next.done = patch.status === "done";
  if (patch.recurrence !== undefined) {
    next.recurrence = patch.recurrence.length > 0 ? patch.recurrence : null;
    next.isMaster = patch.recurrence.length > 0;
  }
  next.kind = classifyKind(next.taskFlag, next.allDay);
  const { startUtc, endUtc } = computeUtc(next.start, next.end, next.allDay, next.timeZone);
  next.startUtc = Timestamp.fromDate(startUtc);
  next.endUtc = Timestamp.fromDate(endUtc);
  next.updatedAt = Timestamp.now();

  await ref.set(stripUndefined(next));

  // Outbound mirror to Google (best-effort).
  if (next.googleEventId && next.googleCalendarId) {
    await mirrorUpdate(next.googleCalendarId, next.googleEventId, mirrorFieldsFromDoc(next));
  } else {
    const mapping = await mirrorCreate(mirrorFieldsFromDoc(next));
    if (mapping) {
      next.googleEventId = mapping.googleEventId;
      next.googleCalendarId = mapping.googleCalendarId;
      try {
      await ref.update({ googleEventId: mapping.googleEventId, googleCalendarId: mapping.googleCalendarId });
    } catch (e) {
      console.error("[sync] googleEventId write-back failed:", e instanceof Error ? e.message : e);
    }
    }
  }
  return docToItem(id, next);
}

/**
 * Delete an event. If `id` is a recurring INSTANCE id, adds an EXDATE (skips that
 * one occurrence); if it's a master or standalone id, deletes the document.
 */
export async function cancelEvent(id: string, calendarId = "primary"): Promise<void> {
  const db = getDb();
  const col = eventsCol(db, calendarId);
  const instance = splitInstanceId(id);
  if (instance) {
    const masterRef = col.doc(instance.masterId);
    const snap = await masterRef.get();
    if (!snap.exists) throw new Error(`Recurring master not found: ${instance.masterId}`);
    await masterRef.update({
      exdates: FieldArrayUnion(instance.instanceKey),
      [`overrides.${instance.instanceKey}`]: FieldDelete(),
      updatedAt: Timestamp.now(),
    });
    return;
  }
  // Capture the Google mapping before deleting so we can mirror the delete.
  const ref = col.doc(id);
  const snap = await ref.get();
  const data = snap.exists ? (snap.data() as EventDoc) : undefined;
  await ref.delete();
  if (data?.googleEventId && data?.googleCalendarId) {
    await mirrorDelete(data.googleCalendarId, data.googleEventId);
  }
}

/** Fetch a single event (master, standalone, or expanded instance) by id, normalized. */
export async function getEvent(id: string, calendarId = "primary"): Promise<CalendarItem> {
  const db = getDb();
  const col = eventsCol(db, calendarId);
  const instance = splitInstanceId(id);
  if (instance) {
    const snap = await col.doc(instance.masterId).get();
    if (!snap.exists) throw new Error(`Recurring master not found: ${instance.masterId}`);
    return buildInstanceItem(instance.masterId, snap.data() as EventDoc, instance.instanceKey);
  }
  const snap = await col.doc(id).get();
  if (!snap.exists) throw new Error(`Event not found: ${id}`);
  return docToItem(id, snap.data() as EventDoc);
}

/**
 * List events for the given local day (`date` as YYYY-MM-DD), normalized to
 * `CalendarItem[]` and sorted by start. Merges standalone events in range with
 * expanded recurring-master instances for the day.
 */
export async function listDayEvents(
  date: string,
  calendarId = "primary",
  timeZone: string = DEFAULT_TIME_ZONE,
): Promise<CalendarItem[]> {
  const db = getDb();
  const col = eventsCol(db, calendarId);
  const { timeMin, timeMax } = dayRangeUtc(date, timeZone);
  const minTs = Timestamp.fromDate(new Date(timeMin));
  const maxTs = Timestamp.fromDate(new Date(timeMax));

  // Step A — standalone (non-master) events whose start is in range.
  const rangeSnap = await col
    .where("startUtc", ">=", minTs)
    .where("startUtc", "<", maxTs)
    .orderBy("startUtc")
    .get();
  const items: Array<{ startUtcMs: number; item: CalendarItem }> = [];
  for (const d of rangeSnap.docs) {
    const doc = d.data() as EventDoc;
    if (doc.isMaster) continue; // masters handled in Step B
    items.push({ startUtcMs: doc.startUtc.toMillis(), item: docToItem(d.id, doc) });
  }

  // Step B — expand recurring masters into instances landing in the window.
  const masterSnap = await col.where("isMaster", "==", true).get();
  for (const d of masterSnap.docs) {
    const master = d.data() as EventDoc;
    for (const inst of expandMaster(d.id, master, timeMin, timeMax)) {
      items.push({ startUtcMs: inst.startUtcMs, item: inst.item });
    }
  }

  items.sort((a, b) => a.startUtcMs - b.startUtcMs || a.item.title.localeCompare(b.item.title));
  return items.map((x) => x.item);
}

/**
 * List the expanded instances of a recurring series `id` within an optional ISO
 * window. Each returned item has its own instance id (usable with
 * updateEvent/cancelEvent to edit/delete a single occurrence).
 */
export async function listEventInstances(
  id: string,
  opts: { timeMin?: string; timeMax?: string; maxResults?: number } = {},
  calendarId = "primary",
): Promise<CalendarItem[]> {
  const db = getDb();
  const col = eventsCol(db, calendarId);
  const snap = await col.doc(id).get();
  if (!snap.exists) throw new Error(`Recurring master not found: ${id}`);
  const master = snap.data() as EventDoc;
  const timeMin = opts.timeMin ?? master.startUtc.toDate().toISOString();
  // Default window: 1 year from start if unbounded.
  const timeMax = opts.timeMax ?? new Date(new Date(timeMin).getTime() + 366 * 86400000).toISOString();
  const expanded = expandMaster(id, master, timeMin, timeMax).sort((a, b) => a.startUtcMs - b.startUtcMs);
  const limited = opts.maxResults ? expanded.slice(0, opts.maxResults) : expanded;
  return limited.map((x) => x.item);
}

// ---------------------------------------------------------------------------
// Recurrence expansion
// ---------------------------------------------------------------------------

/** Build a CalendarItem for one instance of a master, applying an override if present. */
function buildInstanceItem(masterId: string, master: EventDoc, instanceKey: string): CalendarItem {
  const occDate = occDateFromInstanceKey(instanceKey, master.timeZone || DEFAULT_TIME_ZONE);
  const { start, end } = occurrenceStartEnd(master, occDate);
  const override = master.overrides?.[instanceKey];
  return {
    id: `${masterId}_${instanceKey}`,
    kind: master.kind,
    title: override?.title ?? master.title,
    start: override?.start ?? start,
    end: override?.end ?? end,
    allDay: master.allDay,
    location: override?.location ?? master.location,
    notes: override?.notes ?? master.notes,
    done: master.kind === "task" ? (override?.done ?? master.done) : undefined,
    recurring: true,
    recurringEventId: masterId,
    recurrence: undefined,
    source: "firestore",
    raw: undefined,
  };
}

/**
 * The occurrence's LOCAL start date (YYYY-MM-DD) for an instance key.
 * - all-day key (`YYYYMMDD`): the leading digits already ARE the local date.
 * - timed key (`YYYYMMDDTHHMMSSZ`, a UTC instant): convert the UTC instant back
 *   to the local date in `timeZone` — the UTC and local dates differ for events
 *   whose local start crosses a UTC day boundary (e.g. evenings in the Americas),
 *   so we must NOT reuse the key's leading digits as the local date.
 */
function occDateFromInstanceKey(instanceKey: string, timeZone: string): string {
  const timed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(instanceKey);
  if (timed) {
    const utc = new Date(
      Date.UTC(+timed[1], +timed[2] - 1, +timed[3], +timed[4], +timed[5], +timed[6]),
    );
    return todayInTimeZoneOf(utc, timeZone);
  }
  const allDay = /^(\d{4})(\d{2})(\d{2})$/.exec(instanceKey);
  if (!allDay) throw new Error(`Bad instance key: ${instanceKey}`);
  return `${allDay[1]}-${allDay[2]}-${allDay[3]}`;
}

/** Compute an occurrence's wall-clock start/end from the master and the occurrence start date. */
function occurrenceStartEnd(master: EventDoc, occDate: string): { start: string; end: string } {
  if (master.allDay) {
    const span = dateDiffDays(master.end, master.start); // exclusive end span (days)
    return { start: occDate, end: addDaysToDateStr(occDate, span) };
  }
  const startTime = master.start.split("T")[1] ?? "00:00:00";
  const endTime = master.end.split("T")[1] ?? startTime;
  const masterStartDate = master.start.split("T")[0];
  const masterEndDate = master.end.split("T")[0];
  const daySpan = dateDiffDays(masterEndDate, masterStartDate);
  const occEndDate = addDaysToDateStr(occDate, daySpan);
  return { start: `${occDate}T${startTime}`, end: `${occEndDate}T${endTime}` };
}

/** Expand a master into instances whose UTC start is within [timeMinIso, timeMaxIso). */
function expandMaster(
  masterId: string,
  master: EventDoc,
  timeMinIso: string,
  timeMaxIso: string,
): Array<{ startUtcMs: number; item: CalendarItem }> {
  if (!master.recurrence) return [];
  const rule = parseRRule(master.recurrence);
  if (!rule) return [];
  const tz = master.timeZone || DEFAULT_TIME_ZONE;
  const seedDate = master.start.split("T")[0];
  const minMs = new Date(timeMinIso).getTime();
  const maxMs = new Date(timeMaxIso).getTime();

  // Local date of the window's upper bound (+1 day buffer for tz/DST edges).
  const hardMaxLocalDate = addDaysToDateStr(todayInTimeZoneOf(new Date(timeMaxIso), tz), 2);
  const exdates = new Set(master.exdates ?? []);
  const out: Array<{ startUtcMs: number; item: CalendarItem }> = [];

  for (const occDate of enumerateOccurrenceDates(rule, seedDate, hardMaxLocalDate)) {
    const { start } = occurrenceStartEnd(master, occDate);
    const startUtc = master.allDay ? localMidnightUtc(occDate, tz) : localWallClockToUtc(start, tz);
    const ms = startUtc.getTime();
    if (ms < minMs || ms >= maxMs) continue;
    const instanceKey = master.allDay ? occDate.replace(/-/g, "") : basicUtcKey(startUtc);
    if (exdates.has(instanceKey)) continue;
    const override = master.overrides?.[instanceKey];
    if (override?.cancelled) continue;
    out.push({ startUtcMs: ms, item: buildInstanceItem(masterId, master, instanceKey) });
  }
  return out;
}

/** Local date (YYYY-MM-DD) of a UTC instant, observed in `timeZone`. */
function todayInTimeZoneOf(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Wall-clock "YYYY-MM-DDTHH:MM:SS" of a UTC instant, observed in `timeZone`.
 * Used by inbound sync to convert an offset-aware Google `dateTime` into the
 * user's local wall-clock (so `startUtc` is computed from the true instant,
 * not a mis-guessed zone).
 */
export function zonedWallClock(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  return `${m.year}-${m.month}-${m.day}T${m.hour}:${m.minute}:${m.second}`;
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

/** Recursively drop `undefined` values (Firestore rejects them). */
function stripUndefined<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  if (obj instanceof Timestamp) return obj;
  if (Array.isArray(obj)) return obj.map((v) => stripUndefined(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = stripUndefined(v);
  }
  return out as T;
}

// Firestore FieldValue helpers imported lazily to keep the top import list tidy.
import { FieldValue } from "@google-cloud/firestore";
function FieldArrayUnion(value: string): FieldValue {
  return FieldValue.arrayUnion(value);
}
function FieldDelete(): FieldValue {
  return FieldValue.delete();
}
