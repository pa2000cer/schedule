/**
 * Live two-way sync smoke (T23). Exercises the REAL Composio → Google Calendar
 * mirror. Creates clearly-tagged events on the primary calendar and cleans them
 * up (both Firestore and Google) in a finally block.
 *
 * Run:  npx tsx scripts/sync-smoke.ts   (needs ADC + .env.local Composio creds)
 */
import { config } from "dotenv";
config({ path: ".env.local" }); // COMPOSIO_* first
config(); // then .env (no override)

import { setToolContext } from "../server/src/mcp/tools/context";
import { getDb } from "../server/src/calendar/firestore";
import { createEvent, cancelEvent, findByGoogleEventId, todayInTimeZone, DEFAULT_TIME_ZONE } from "../server/src/calendar/calendar";
import { isSyncConfigured, gcalListEvents, gcalCreateEvent, gcalDeleteEvent } from "../server/src/sync/composio";
import { importFromGoogle } from "../server/src/sync/inbound";
import { getSyncSettings, outboundCalendarId, setCalendarSync } from "../server/src/sync/settings";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail !== undefined ? "  → " + JSON.stringify(detail) : ""}`);
  if (!cond) failures += 1;
}

async function deleteFirestoreByGoogleId(gid: string) {
  const snap = await getDb().collection("calendars").doc("primary").collection("events").where("googleEventId", "==", gid).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function main() {
  check("sync configured (Composio creds present)", isSyncConfigured());
  if (!isSyncConfigured()) { process.exit(1); }
  setToolContext({ timeZone: DEFAULT_TIME_ZONE });

  const today = todayInTimeZone(DEFAULT_TIME_ZONE);
  const gcal = await outboundCalendarId();
  console.log(`  outbound calendar: ${gcal}`);
  const settings = await getSyncSettings();
  check("settings/sync persisted with >=1 calendar", settings.calendars.length >= 1, settings.calendars.map((c) => ({ id: c.googleCalendarId, enabled: c.enabled })));

  let outGid: string | undefined;
  let inGid: string | undefined;
  try {
    // --- OUTBOUND: create via store → should appear in Google ---
    const item = await createEvent({ title: "__SYNC SMOKE OUT__", start: `${today}T16:00:00`, end: `${today}T16:30:00` });
    outGid = (item.raw as any)?.googleEventId;
    check("outbound: store event got a googleEventId", Boolean(outGid), item.raw);
    if (outGid) {
      const gEvents = await gcalListEvents(gcal, { timeMin: `${today}T00:00:00Z`, timeMax: `${today}T23:59:59Z`, singleEvents: true });
      check("outbound: event present in Google Calendar", gEvents.some((e) => e.id === outGid), gEvents.map((e) => e.summary));
    }
    // delete via store → should disappear from Google
    if (outGid) {
      await cancelEvent(item.id);
      const gEvents2 = await gcalListEvents(gcal, { timeMin: `${today}T00:00:00Z`, timeMax: `${today}T23:59:59Z`, singleEvents: true });
      check("outbound: delete removed it from Google", !gEvents2.some((e) => e.id === outGid), gEvents2.map((e) => e.id));
      outGid = undefined; // cleaned
    }

    // --- INBOUND: create directly in Google at a FAR-FUTURE date (so we never
    //     import the user's real events) → sync_now imports into Firestore ---
    const FUTURE = "2030-03-15";
    inGid = await gcalCreateEvent(gcal, {
      title: "__SYNC SMOKE IN__", start: `${FUTURE}T18:00:00`, end: `${FUTURE}T18:45:00`,
      allDay: false, timeZone: DEFAULT_TIME_ZONE, taskFlag: false,
    });
    check("inbound: created a Google event to import", Boolean(inGid));
    const res = await importFromGoogle({ timeMin: `${FUTURE}T00:00:00Z`, timeMax: `${FUTURE}T23:59:59Z` });
    console.log(`  importFromGoogle: ${JSON.stringify(res)}`);
    check("inbound: event imported into Firestore", await findByGoogleEventId(inGid!), inGid);

    // Firestore-wins: a second import must NOT duplicate it
    const res2 = await importFromGoogle({ timeMin: `${FUTURE}T00:00:00Z`, timeMax: `${FUTURE}T23:59:59Z` });
    const snap = await getDb().collection("calendars").doc("primary").collection("events").where("googleEventId", "==", inGid!).get();
    check("inbound idempotent: no duplicate on re-sync (Firestore wins)", snap.size === 1, { size: snap.size, res2 });

    // --- BUG 2 regression: disabling all calendars stops OUTBOUND mirroring ---
    for (const c of settings.calendars) { if (c.enabled) await setCalendarSync(c.googleCalendarId, false); }
    const noMirror = await createEvent({ title: "__SYNC SMOKE NOMIRROR__", start: `${FUTURE}T20:00:00`, end: `${FUTURE}T20:30:00` });
    check("outbound disabled: no googleEventId when all calendars off", !(noMirror.raw as any)?.googleEventId, noMirror.raw);
    await cancelEvent(noMirror.id); // local-only delete
    // restore: re-enable the primary calendar
    await setCalendarSync(gcal, true);
  } finally {
    // Cleanup: remove any test artifacts from both Google and Firestore.
    if (outGid) { try { await gcalDeleteEvent(gcal, outGid); } catch {} await deleteFirestoreByGoogleId(outGid); }
    if (inGid) { try { await gcalDeleteEvent(gcal, inGid); } catch {} await deleteFirestoreByGoogleId(inGid); }
    setToolContext(null);
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("SYNC SMOKE ERROR:", e?.stack ?? e); process.exit(1); });
