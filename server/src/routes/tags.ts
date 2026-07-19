/**
 * Tag management routes for the web UI (T30).
 *
 *   GET  /api/tags            — available tags
 *   POST /api/tags/add    { name }
 *   POST /api/tags/remove { name }
 *
 * Behind the app-wide `requireAuth` guard. Applying tags to an event goes
 * through the event routes (`/api/event/{create,update}` accept a `tags` array).
 */
import { Router, type Request, type Response } from "express";
import { getTags, addTag, removeTag } from "../tags/tags";

export const tagsRouter = Router();

tagsRouter.get("/api/tags", async (_req: Request, res: Response) => {
  try {
    res.status(200).json({ tags: await getTags() });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[tags] list error:", err);
    res.status(502).json({ error: "tags_failed" });
  }
});

tagsRouter.post("/api/tags/add", async (req: Request, res: Response) => {
  const name = req.body?.name;
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "missing_name" });
    return;
  }
  try {
    res.status(200).json({ ok: true, tags: await addTag(name) });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[tags] add error:", err);
    res.status(502).json({ error: "tag_add_failed" });
  }
});

tagsRouter.post("/api/tags/remove", async (req: Request, res: Response) => {
  const name = req.body?.name;
  if (typeof name !== "string" || !name) {
    res.status(400).json({ error: "missing_name" });
    return;
  }
  try {
    res.status(200).json({ ok: true, tags: await removeTag(name) });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[tags] remove error:", err);
    res.status(502).json({ error: "tag_remove_failed" });
  }
});
