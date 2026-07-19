import { Router } from "express";

export const healthRouter = Router();

// Placeholder health-check route used by Cloud Run / uptime checks.
healthRouter.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});
