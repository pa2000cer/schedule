/**
 * Real day-view + task-complete routes (T12, Goal C).
 *
 *   GET  /api/day?date=YYYY-MM-DD     — merged one-day view (appointments,
 *                                       tasks with done-state, grooming routine).
 *   POST /api/task/complete { id, done } — persist a task's done-state to Google.
 *
 * Both run behind the app-wide `requireAuth` guard (see server/src/index.ts).
 * The event store is Firestore (ADC) — no Google token is needed. Each request
 * sets the non-secret tool context (timezone), drives the T7 MCP tools through an
 * in-process client, and clears context in a `finally`. Store failures surface as
 * a 502 with a logged detail rather than crashing the request.
 */
import { Router, type Request, type Response } from "express";
import { setToolContext } from "../mcp/tools/context";
import { connectInProcessMcp } from "../mcp/inProcessClient";
import { DEFAULT_TIME_ZONE } from "../calendar/calendar";

export const dayRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Set the per-request non-secret tool context (timezone). */
function injectContext(): void {
  setToolContext({ timeZone: process.env.APP_TIMEZONE || DEFAULT_TIME_ZONE });
}

dayRouter.get("/api/day", async (req: Request, res: Response) => {
  const date = String(req.query.date ?? "");
  if (!DATE_RE.test(date)) {
    res.status(400).json({ error: "invalid_date", message: "date must be YYYY-MM-DD" });
    return;
  }
  injectContext();
  const mcp = await connectInProcessMcp();
  try {
    const { text, isError } = await mcp.callTool("get_day", { date });
    const payload = JSON.parse(text);
    if (isError) {
      // eslint-disable-next-line no-console
      console.error("[day] get_day tool error:", payload.error);
      res.status(502).json({ error: "day_fetch_failed", detail: payload.error });
      return;
    }
    res.status(200).json(payload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[day] error fetching day:", err);
    res.status(502).json({ error: "day_fetch_failed" });
  } finally {
    await mcp.close();
    setToolContext(null);
  }
});

dayRouter.post("/api/task/complete", async (req: Request, res: Response) => {
  const id = req.body?.id;
  const done = req.body?.done;
  if (typeof id !== "string" || id.length === 0) {
    res.status(400).json({ error: "missing_id" });
    return;
  }
  if (typeof done !== "boolean") {
    res.status(400).json({ error: "missing_done", message: "done must be a boolean" });
    return;
  }
  injectContext();
  const mcp = await connectInProcessMcp();
  try {
    const { text, isError } = await mcp.callTool("complete_task", { id, done });
    const payload = JSON.parse(text);
    if (isError) {
      // eslint-disable-next-line no-console
      console.error("[day] complete_task tool error:", payload.error);
      res.status(502).json({ error: "task_complete_failed", detail: payload.error });
      return;
    }
    res.status(200).json(payload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[day] error completing task:", err);
    res.status(502).json({ error: "task_complete_failed" });
  } finally {
    await mcp.close();
    setToolContext(null);
  }
});
