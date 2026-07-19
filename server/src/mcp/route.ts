/**
 * Express wiring for the MCP endpoint: `POST/GET/DELETE /mcp`.
 *
 * Mounted directly on the app (NOT under `/api`), reusing the existing
 * Express app/HTTP server rather than standing up a second listener — this
 * keeps the whole thing deployable as one Cloud Run service.
 *
 * Auth: every method on `/mcp` goes through `requireMcpAuth` (bearer token),
 * independent of the cookie-based `requireAuth` guard applied to `/api/*`.
 *
 * Session model: standard MCP Streamable HTTP session pattern per the SDK
 * docs — a fresh `McpServer` + `StreamableHTTPServerTransport` pair is
 * created on the client's `initialize` request, keyed by a generated
 * `mcp-session-id`; subsequent requests carrying that header reuse the same
 * pair. This matches how long-lived MCP clients (Claude Desktop/Code, T17)
 * actually connect: one session, many tool calls.
 */
import { randomUUID } from "crypto";
import { Router, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "./server";
import { requireMcpAuth } from "./auth";

export const mcpRouter = Router();

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

/** In-memory session store. Fine for a single-user, single-instance server. */
const sessions = new Map<string, McpSession>();

// Every /mcp method requires the bearer token, checked before any MCP
// protocol handling runs.
mcpRouter.use("/mcp", requireMcpAuth);

/** Shared handler for GET (server->client notifications) and DELETE (session close). */
async function handleExistingSession(req: Request, res: Response): Promise<void> {
  const sessionId = req.header("mcp-session-id");
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!sessionId || !session) {
    res.status(400).json({ error: "invalid_or_missing_session" });
    return;
  }
  await session.transport.handleRequest(req, res);
}

mcpRouter.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.header("mcp-session-id");

  // Reuse an existing session.
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // No session header: only a fresh `initialize` request may start one.
  if (isInitializeRequest(req.body)) {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, { server, transport });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({
    error: "bad_request",
    message: "Missing mcp-session-id and request is not an initialize request.",
  });
});

mcpRouter.get("/mcp", handleExistingSession);
mcpRouter.delete("/mcp", handleExistingSession);
