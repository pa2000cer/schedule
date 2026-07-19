/**
 * Scheduled inbound sync (T28) — a configurable auto-pull from Google.
 *
 * A Cloud Scheduler job pings `POST /internal/sync/tick` on a heartbeat; this
 * module decides whether an actual sync is due based on **configurable settings**
 * persisted in Firestore (`settings/schedule`): enabled, interval, active window
 * (start/end time), and timezone. Defaults: every 10 min, 07:00–22:00, America/New_York.
 *
 * The settings are editable via the web Settings UI (`/api/sync/schedule`), so the
 * cadence/window can change without touching Cloud Scheduler — the scheduler is
 * just a fine-grained heartbeat and this logic enforces the real policy.
 */
import { getDb } from "../calendar/firestore";
import { Timestamp } from "@google-cloud/firestore";
import { DEFAULT_TIME_ZONE } from "../calendar/calendar";
import { setToolContext } from "../mcp/tools/context";
import { importFromGoogle, type SyncResult } from "./inbound";
import { isSyncConfigured } from "./composio";

export interface ScheduleSettings {
  enabled: boolean;
  intervalMinutes: number;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  timeZone: string;
  /** Epoch ms of the last actual sync run (undefined until first run). */
  lastRunAtMs?: number;
}

const DEFAULTS: ScheduleSettings = {
  enabled: true,
  intervalMinutes: 10,
  startHour: 7,
  startMinute: 0,
  endHour: 22,
  endMinute: 0,
  timeZone: DEFAULT_TIME_ZONE,
};

function ref() {
  return getDb().collection("settings").doc("schedule");
}

/** Read schedule settings, seeding defaults on first use. */
export async function getScheduleSettings(): Promise<ScheduleSettings> {
  const snap = await ref().get();
  if (snap.exists) return { ...DEFAULTS, ...(snap.data() as ScheduleSettings) };
  await ref().set(DEFAULTS);
  return { ...DEFAULTS };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Validate + persist a partial update to the schedule settings. */
export async function setScheduleSettings(patch: Partial<ScheduleSettings>): Promise<ScheduleSettings> {
  const cur = await getScheduleSettings();
  const next: ScheduleSettings = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    intervalMinutes: patch.intervalMinutes !== undefined ? clampInt(patch.intervalMinutes, 1, 1440, cur.intervalMinutes) : cur.intervalMinutes,
    startHour: patch.startHour !== undefined ? clampInt(patch.startHour, 0, 23, cur.startHour) : cur.startHour,
    startMinute: patch.startMinute !== undefined ? clampInt(patch.startMinute, 0, 59, cur.startMinute) : cur.startMinute,
    endHour: patch.endHour !== undefined ? clampInt(patch.endHour, 0, 23, cur.endHour) : cur.endHour,
    endMinute: patch.endMinute !== undefined ? clampInt(patch.endMinute, 0, 59, cur.endMinute) : cur.endMinute,
    timeZone: typeof patch.timeZone === "string" && patch.timeZone.trim() ? patch.timeZone.trim() : cur.timeZone,
    lastRunAtMs: cur.lastRunAtMs,
  };
  await ref().set(next);
  return next;
}

/** Current minutes-since-midnight in `timeZone`. */
function nowMinutesInTz(timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  return Number(m.hour) * 60 + Number(m.minute);
}

export interface TickResult {
  ran: boolean;
  reason: "disabled" | "not_configured" | "outside_window" | "not_due" | "ran";
  result?: SyncResult;
  nextEligibleInMin?: number;
}

/**
 * Heartbeat handler: run an inbound sync iff enabled, inside the active window,
 * and at least `intervalMinutes` since the last run. Updates `lastRunAtMs`.
 */
export async function runScheduledTick(): Promise<TickResult> {
  if (!isSyncConfigured()) return { ran: false, reason: "not_configured" };
  const s = await getScheduleSettings();
  if (!s.enabled) return { ran: false, reason: "disabled" };

  const cur = nowMinutesInTz(s.timeZone);
  const startMin = s.startHour * 60 + s.startMinute;
  const endMin = s.endHour * 60 + s.endMinute;
  const inWindow = startMin <= endMin ? cur >= startMin && cur <= endMin : cur >= startMin || cur <= endMin;
  if (!inWindow) return { ran: false, reason: "outside_window" };

  const now = Date.now();
  if (s.lastRunAtMs) {
    const elapsedMin = (now - s.lastRunAtMs) / 60000;
    // 1-minute tolerance so heartbeat jitter doesn't push a run to the next tick.
    if (elapsedMin < s.intervalMinutes - 1) {
      return { ran: false, reason: "not_due", nextEligibleInMin: Math.ceil(s.intervalMinutes - elapsedMin) };
    }
  }

  // Incremental after the first run: only pull events changed since last sync.
  const opts = s.lastRunAtMs ? { updatedMin: new Date(s.lastRunAtMs).toISOString() } : undefined;
  setToolContext({ timeZone: s.timeZone });
  let result: SyncResult;
  try {
    result = await importFromGoogle(opts);
  } finally {
    setToolContext(null);
  }
  await ref().set({ ...s, lastRunAtMs: now });
  return { ran: true, reason: "ran", result };
}
