import "dotenv/config";
import path from "path";
import express from "express";
import cookieParser from "cookie-parser";
import { healthRouter } from "./routes/health";
import { authRouter } from "./routes/auth";
import { assistantRouter } from "./routes/assistant";
import { dayRouter } from "./routes/day";
import { syncRouter } from "./routes/sync";
import { requireAuth } from "./auth/requireAuth";
import { mcpRouter } from "./mcp/route";
import { syncCronRouter } from "./routes/syncCron";

const app = express();
const port = Number(process.env.PORT) || 8080;

app.use(express.json());
app.use(cookieParser());

// Public routes.
app.use(healthRouter); // GET /health
app.use(authRouter); // /auth/* (public) and /api/me (self-protected by requireAuth)

// MCP endpoint (T6): its own bearer-token auth (see mcp/auth.ts), NOT the
// cookie-based session guard below. Mounted at the app root (`/mcp`, not
// `/api/mcp`) and before the /api guard so it is never subject to it.
app.use(mcpRouter); // POST/GET/DELETE /mcp (self-protected by requireMcpAuth)
app.use(syncCronRouter); // POST /internal/sync/tick (self-protected by requireMcpAuth) — Cloud Scheduler heartbeat

// Everything under /api/* (except the auth-owned /api/me above) requires a
// valid, allowlisted session. Mounted AFTER authRouter so /api/me resolves
// first; any other /api route falls through to this guard.
app.use("/api", requireAuth);
app.use(assistantRouter); // POST /api/assistant (T12) — protected by the requireAuth above
app.use(dayRouter); // GET /api/day, POST /api/task/complete (T12) — protected by requireAuth above
app.use(syncRouter); // GET/POST /api/sync/* (T27) — protected by requireAuth above

// Static frontend (T11): serves frontend/index.html at "/" plus app.js/
// styles.css. Public — the page itself calls GET /api/me client-side and
// renders a sign-in gate when unauthenticated, so no requireAuth here; the
// server-side allowlist still guards every real /api/* and /mcp call. Mounted
// LAST so it never shadows /health, /auth/*, /mcp, or /api/* above — static
// only responds when no earlier router matched and a file actually exists.
// Resolved via process.cwd() (repo root for both `npm run dev` / `node
// dist/index.js` run from the repo root, and the Docker image's WORKDIR
// /app, which the Dockerfile COPYs frontend into as ./frontend) rather than
// __dirname, since __dirname differs between the tsx dev entrypoint
// (server/src) and the compiled dist/index.js (dist).
app.use(express.static(path.join(process.cwd(), "frontend")));

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Personal Calendar server listening on port ${port}`);
});
