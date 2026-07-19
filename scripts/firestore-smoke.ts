/**
 * Firestore CRUD smoke (T19/T20 acceptance).
 *
 * Drives the REAL registered MCP tools through the in-memory client↔server pair
 * — the exact tools/schemas/handlers a remote MCP client would call — but with
 * **no Google token**. The store is Firestore (ADC); writes go to a dedicated
 * `_smoke` calendar so real data is untouched and cleanup is a wipe.
 *
 * Run:  npx tsx scripts/firestore-smoke.ts   (needs ADC or FIRESTORE_EMULATOR_HOST)
 */
import "dotenv/config";
import { connectInProcessMcp } from "../server/src/mcp/inProcessClient";
import { setToolContext } from "../server/src/mcp/tools/context";
import { getDb } from "../server/src/calendar/firestore";

const CAL = "_smoke";
const TZ = "America/New_York";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail !== undefined ? "  → " + JSON.stringify(detail) : ""}`);
  }
}

async function wipe() {
  const snap = await getDb().collection("calendars").doc(CAL).collection("events").get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function main() {
  setToolContext({ calendarId: CAL, timeZone: TZ });
  await wipe();
  const mcp = await connectInProcessMcp();
  const call = async (name: string, args: Record<string, unknown>) => {
    const { text, isError } = await mcp.callTool(name, args);
    return { payload: JSON.parse(text) as any, isError };
  };

  try {
    // 1. grooming still merges (non-Google path) + empty schedule
    const day0 = await call("get_day", { date: "2026-07-20" });
    check("get_day shape {date,appointments,tasks,grooming}",
      Array.isArray(day0.payload.appointments) && Array.isArray(day0.payload.tasks) && Array.isArray(day0.payload.grooming),
      day0.payload);
    check("grooming non-empty (Firestore-independent)", day0.payload.grooming.length > 0);
    check("no appointments yet", day0.payload.appointments.length === 0);

    // 2. appointment CRUD
    const add = await call("add_appointment", {
      title: "Dentist", start: "2026-07-20T15:00:00", end: "2026-07-20T16:00:00", location: "Downtown",
    });
    check("add_appointment ok + source firestore",
      add.payload.ok && add.payload.appointment?.kind === "appointment" && add.payload.appointment?.source === "firestore",
      add.payload);
    const apptId = add.payload.appointment.id;

    const day1 = await call("get_day", { date: "2026-07-20" });
    check("get_day lists the appointment",
      day1.payload.appointments.some((a: any) => a.id === apptId && a.title === "Dentist"), day1.payload.appointments);

    const upd = await call("update_appointment", { id: apptId, title: "Dentist (rescheduled)" });
    check("update_appointment changes title", upd.payload.appointment?.title === "Dentist (rescheduled)", upd.payload);

    // 3. task CRUD + done-state
    const addTask = await call("add_task", { title: "Buy groceries", date: "2026-07-20" });
    check("add_task all-day task done=false",
      addTask.payload.task?.kind === "task" && addTask.payload.task?.allDay === true && addTask.payload.task?.done === false,
      addTask.payload);
    const taskId = addTask.payload.task.id;

    const done = await call("complete_task", { id: taskId, done: true });
    check("complete_task marks done", done.payload.done === true && done.payload.task?.done === true, done.payload);

    const day2 = await call("get_day", { date: "2026-07-20" });
    check("get_day shows task done=true",
      day2.payload.tasks.some((t: any) => t.id === taskId && t.done === true), day2.payload.tasks);

    // 4. recurring series (weekly Mondays) + expansion
    const rec = await call("add_recurring", {
      title: "Standup", start: "2026-07-20T09:00:00", end: "2026-07-20T09:15:00",
      recurrence: { freq: "WEEKLY", byDay: ["MO"] },
    });
    check("add_recurring returns series master + rrule",
      rec.payload.series?.recurring === true && Array.isArray(rec.payload.rrule) && /FREQ=WEEKLY/.test(rec.payload.rrule[0]),
      rec.payload);
    const seriesId = rec.payload.series.id;

    const wk1 = await call("get_day", { date: "2026-07-20" });
    const inst1 = wk1.payload.appointments.find((a: any) => a.recurringEventId === seriesId);
    check("recurring instance expanded on 07-20 (Mon)", Boolean(inst1) && inst1.id.includes("_"), wk1.payload.appointments);
    const wk2 = await call("get_day", { date: "2026-07-27" });
    check("recurring instance also on 07-27 (next Mon)",
      wk2.payload.appointments.some((a: any) => a.recurringEventId === seriesId), wk2.payload.appointments);
    const noRec = await call("get_day", { date: "2026-07-21" });
    check("no recurring instance on 07-21 (Tue)",
      !noRec.payload.appointments.some((a: any) => a.recurringEventId === seriesId), noRec.payload.appointments);

    // 5. per-instance override (update just 07-27 occurrence)
    const instId = wk2.payload.appointments.find((a: any) => a.recurringEventId === seriesId).id;
    await call("update_recurring", { id: instId, scope: "instance", title: "Standup (special)" });
    const wk2b = await call("get_day", { date: "2026-07-27" });
    check("instance override changes only 07-27",
      wk2b.payload.appointments.find((a: any) => a.recurringEventId === seriesId)?.title === "Standup (special)", wk2b.payload.appointments);
    const wk1b = await call("get_day", { date: "2026-07-20" });
    check("07-20 occurrence unchanged by override",
      wk1b.payload.appointments.find((a: any) => a.recurringEventId === seriesId)?.title === "Standup", wk1b.payload.appointments);

    // 6. delete one instance (EXDATE)
    await call("delete_recurring", { id: instId, scope: "instance" });
    const wk2c = await call("get_day", { date: "2026-07-27" });
    check("EXDATE removes only 07-27 occurrence",
      !wk2c.payload.appointments.some((a: any) => a.recurringEventId === seriesId), wk2c.payload.appointments);
    const wk3 = await call("get_day", { date: "2026-08-03" });
    check("later occurrence 08-03 still present",
      wk3.payload.appointments.some((a: any) => a.recurringEventId === seriesId), wk3.payload.appointments);

    // 7. delete series
    await call("delete_recurring", { id: seriesId, scope: "series" });
    const wk1c = await call("get_day", { date: "2026-07-20" });
    check("series delete removes all occurrences",
      !wk1c.payload.appointments.some((a: any) => a.recurringEventId === seriesId), wk1c.payload.appointments);

    // 7b. EVENING recurring event (local start crosses UTC midnight) — BUG 1 regression.
    const night = await call("add_recurring", {
      title: "Night call", start: "2026-07-20T23:00:00", end: "2026-07-20T23:30:00",
      recurrence: { freq: "WEEKLY", byDay: ["MO"] },
    });
    const nightSeries = night.payload.series.id;
    const nWk = await call("get_day", { date: "2026-07-27" });
    const nInst = nWk.payload.appointments.find((a: any) => a.recurringEventId === nightSeries);
    check("evening recurring instance emits the correct LOCAL date (not +1)",
      Boolean(nInst) && nInst.start === "2026-07-27T23:00:00" && nInst.end === "2026-07-27T23:30:00",
      nInst);
    // and getEvent on the instance id round-trips to the same local date
    const nGet = await call("get_day", { date: "2026-07-20" });
    const nInst0 = nGet.payload.appointments.find((a: any) => a.recurringEventId === nightSeries);
    check("evening instance on its seed day is 07-20 (not 07-21)",
      Boolean(nInst0) && nInst0.start === "2026-07-20T23:00:00", nInst0);
    await call("delete_recurring", { id: nightSeries, scope: "series" });

    // 8. delete appointment + task
    const delA = await call("delete_appointment", { id: apptId });
    const delT = await call("delete_task", { id: taskId });
    check("delete_appointment ok", delA.payload.ok && delA.payload.deletedId === apptId, delA.payload);
    check("delete_task ok", delT.payload.ok && delT.payload.deletedId === taskId, delT.payload);
    const dayEnd = await call("get_day", { date: "2026-07-20" });
    check("day clear after deletes (only grooming remains)",
      dayEnd.payload.appointments.length === 0 && dayEnd.payload.tasks.length === 0, dayEnd.payload);
  } finally {
    await mcp.close();
    await wipe();
    setToolContext(null);
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("SMOKE ERROR:", e?.stack ?? e); process.exit(1); });
