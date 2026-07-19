/**
 * Scheduled-sync heartbeat endpoint (T28).
 *
 *   POST /internal/sync/tick  — called by Cloud Scheduler on a heartbeat.
 *
 * NOT behind the session `requireAuth` guard (Cloud Scheduler can't hold a
 * cookie). Protected by the same bearer token as `/mcp` (`requireMcpAuth`);
 * Cloud Scheduler sends `Authorization: Bearer <MCP_AUTH_TOKEN>`. The actual
 * sync only runs if the configurable schedule says it's due (see sync/schedule).
 */
import { Router, type Request, type Response } from "express";
import { requireMcpAuth } from "../mcp/auth";
import { runScheduledTick } from "../sync/schedule";

export const syncCronRouter = Router();

syncCronRouter.post("/internal/sync/tick", requireMcpAuth, async (_req: Request, res: Response) => {
  try {
    const result = await runScheduledTick();
    // eslint-disable-next-line no-console
    console.log(`[sync] tick: ${result.reason}${result.ran ? " " + JSON.stringify(result.result) : ""}`);
    res.status(200).json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[sync] scheduled tick error:", err);
    res.status(500).json({ error: "tick_failed" });
  }
});
