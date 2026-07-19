/**
 * Bearer-token auth for the MCP endpoint.
 *
 * The MCP endpoint (`/mcp`) is a separate trust boundary from the browser
 * front end:
 *   - The front end authenticates with the signed session COOKIE (see
 *     `../auth/requireAuth.ts`), enforced on everything under `/api/*`.
 *   - MCP clients (Claude Desktop, Claude Code — see T17) are not browsers and
 *     don't carry cookies. They authenticate with a static bearer TOKEN in the
 *     `Authorization: Bearer <token>` header, compared against `MCP_AUTH_TOKEN`.
 *
 * `/mcp` is mounted at the app root (not under `/api`), so it is never routed
 * through the cookie-based `requireAuth` guard. This middleware is its own,
 * independent gate — missing/mismatched token -> 401, no session involved.
 */
import type { NextFunction, Request, Response } from "express";

const AUTH_HEADER_PREFIX = "Bearer ";

/** Read MCP_AUTH_TOKEN, failing loudly if unset (never allow an open endpoint). */
function getExpectedToken(): string {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new Error(
      "MCP_AUTH_TOKEN is not set. Refusing to serve /mcp without a bearer token configured.",
    );
  }
  return token;
}

/** Constant-time-ish comparison guard against trivial timing leaks on a single-user token. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Express middleware: require `Authorization: Bearer <MCP_AUTH_TOKEN>`.
 * Responds 401 JSON on missing/malformed/mismatched header.
 */
export function requireMcpAuth(req: Request, res: Response, next: NextFunction): void {
  let expected: string;
  try {
    expected = getExpectedToken();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[mcp] auth misconfigured:", err);
    res.status(500).json({ error: "mcp_auth_not_configured" });
    return;
  }

  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header || !header.startsWith(AUTH_HEADER_PREFIX)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const provided = header.slice(AUTH_HEADER_PREFIX.length).trim();
  if (!provided || !timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
}
