/**
 * Authentication middleware.
 *
 * Reads and verifies the signed session cookie, then RE-CHECKS the session's
 * email against the current ALLOWED_EMAIL on every request (defense in depth):
 * even a validly-signed, unexpired session is rejected the instant the
 * allowlist changes. This makes allowlist revocation take effect immediately.
 *
 * Response behavior on failure:
 *   - `/api/*`  → 401 JSON (so the SPA/fetch layer sees a clean status).
 *   - anything else (page routes) → 302 redirect to /auth/google/login.
 */
import type { NextFunction, Request, Response } from "express";
import { isAllowed } from "./allowlist";
import { readSession, type SessionData } from "./session";

/** Augment Express Request with the resolved session. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionData;
    }
  }
}

function isApiPath(req: Request): boolean {
  // Use originalUrl (not req.path) so this is correct whether requireAuth is
  // used inline on a root-mounted router (/api/me) OR mounted under app.use("/api", ...),
  // where Express strips the /api prefix from req.path.
  const pathOnly = req.originalUrl.split("?")[0];
  return pathOnly === "/api" || pathOnly.startsWith("/api/");
}

function reject(req: Request, res: Response): void {
  if (isApiPath(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.redirect("/auth/google/login");
}

/**
 * Express middleware enforcing an authenticated + allowlisted session.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const session = readSession(req);
  if (!session) {
    reject(req, res);
    return;
  }
  // Defense in depth: the email must STILL be on the allowlist right now.
  // We re-verify against the (already Google-verified) session — email_verified
  // was enforced at login time, so we pass `true` here and only re-test the
  // allowlist membership.
  if (!isAllowed(session.email, true)) {
    reject(req, res);
    return;
  }
  req.session = session;
  next();
}
