/**
 * Event CRUD routes for the web UI (T29) — create / update / delete an
 * appointment or task directly from the day view's editor modal.
 *
 *   POST /api/event/create  { kind, title, allDay, date|start, end?, location?, notes?, done? }
 *   POST /api/event/update  { id, ...same fields }
 *   POST /api/event/delete  { id }
 *
 * Behind the app-wide `requireAuth` guard. These drive the Firestore store
 * directly (which mirrors out to Google via the sync layer). For a recurring
 * instance id, update records a per-occurrence override and delete an EXDATE —
 * the store routes by id automatically.
 */
import { Router, type Request, type Response } from "express";
import {
  createEvent,
  updateEvent,
  cancelEvent,
  addDaysToDateStr,
  DEFAULT_TIME_ZONE,
  type CreateEventInput,
  type UpdateEventPatch,
} from "../calendar/calendar";

export const eventRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const tz = () => process.env.APP_TIMEZONE || DEFAULT_TIME_ZONE;

eventRouter.post("/api/event/create", async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) {
    res.status(400).json({ error: "missing_title" });
    return;
  }
  const isTask = b.kind === "task";
  const allDay = Boolean(b.allDay);
  try {
    let input: CreateEventInput;
    if (allDay) {
      if (!DATE_RE.test(b.date || "")) {
        res.status(400).json({ error: "invalid_date" });
        return;
      }
      input = {
        title,
        start: b.date,
        end: addDaysToDateStr(b.date, 1),
        allDay: true,
        notes: b.notes || undefined,
        task: isTask,
        status: isTask ? (b.done ? "done" : "todo") : undefined,
      };
    } else {
      if (typeof b.start !== "string" || !b.start) {
        res.status(400).json({ error: "missing_start" });
        return;
      }
      input = {
        title,
        start: b.start,
        end: b.end || b.start,
        allDay: false,
        timeZone: tz(),
        location: !isTask ? b.location || undefined : undefined,
        notes: b.notes || undefined,
        task: isTask,
        status: isTask ? (b.done ? "done" : "todo") : undefined,
      };
    }
    if (Array.isArray(b.tags)) input.tags = b.tags.filter((t: unknown) => typeof t === "string");
    const item = await createEvent(input);
    res.status(200).json({ ok: true, item });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[event] create error:", err);
    res.status(502).json({ error: "create_failed" });
  }
});

eventRouter.post("/api/event/update", async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const id = typeof b.id === "string" ? b.id : "";
  if (!id) {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  try {
    const patch: UpdateEventPatch = {};
    if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim();
    if (b.notes !== undefined) patch.notes = b.notes || "";
    if (b.location !== undefined) patch.location = b.location || "";
    if (b.allDay === true) {
      if (!DATE_RE.test(b.date || "")) {
        res.status(400).json({ error: "invalid_date" });
        return;
      }
      patch.start = b.date;
      patch.end = addDaysToDateStr(b.date, 1);
      patch.allDay = true;
    } else if (b.allDay === false && typeof b.start === "string" && b.start) {
      patch.start = b.start;
      patch.end = b.end || b.start;
      patch.allDay = false;
      patch.timeZone = tz();
    }
    if (typeof b.done === "boolean") patch.status = b.done ? "done" : "todo";
    if (Array.isArray(b.tags)) patch.tags = b.tags.filter((t: unknown) => typeof t === "string");
    const item = await updateEvent(id, patch);
    res.status(200).json({ ok: true, item });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[event] update error:", err);
    res.status(502).json({ error: "update_failed" });
  }
});

eventRouter.post("/api/event/delete", async (req: Request, res: Response) => {
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (!id) {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  try {
    await cancelEvent(id);
    res.status(200).json({ ok: true, deletedId: id });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[event] delete error:", err);
    res.status(502).json({ error: "delete_failed" });
  }
});
