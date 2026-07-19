/**
 * POST /api/assistant — the front end's "ask" affordance, backed by the REAL
 * agentic assistant (T12). Claude drives the T7 MCP calendar tools to actually
 * perform the requested actions (add/edit/delete appointments, tasks, recurring
 * series, complete/reschedule tasks) on the signed-in user's Google Calendar.
 *
 * Auth: mounted after the app-wide `requireAuth` guard on `/api/*` (see
 * server/src/index.ts), so only the signed-in allowlisted session reaches here,
 * and `req.session` carries the user's Google tokens (T4).
 *
 * The Anthropic API key lives server-side only (`ANTHROPIC_API_KEY`); the front
 * end never supplies one. Missing key → 500 `assistant_not_configured`. Missing
 * Google tokens (shouldn't happen post-login) → 400 with a clear message.
 *
 * Response: `{ finalText, actions, route, model }` — `actions` lists the tool
 * calls actually executed so the UI can show (and react to) what changed.
 */
import { Router, type Request, type Response } from "express";
import { runAssistant } from "../assistant/agent";
import { DEFAULT_TIME_ZONE, todayInTimeZone } from "../calendar/calendar";

export const assistantRouter = Router();

assistantRouter.post("/api/assistant", async (req: Request, res: Response) => {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    res.status(500).json({ error: "assistant_not_configured" });
    return;
  }

  const request = req.body?.request;
  if (typeof request !== "string" || request.trim().length === 0) {
    res.status(400).json({ error: "missing_request" });
    return;
  }

  const timeZone = process.env.APP_TIMEZONE || DEFAULT_TIME_ZONE;
  const today = todayInTimeZone(timeZone);

  try {
    const { finalText, actions, route, model } = await runAssistant(request, {
      apiKey,
      timeZone,
      today,
    });
    res.status(200).json({ finalText, actions, route, model });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[assistant] runAssistant error:", err);
    res.status(502).json({ error: "assistant_failed" });
  }
});
