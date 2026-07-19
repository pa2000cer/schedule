/**
 * Factory for a configured MCP `McpServer` instance.
 *
 * One `McpServer` is created per Streamable HTTP session (see `./route.ts`) —
 * the SDK ties a `Server`/`McpServer` to exactly one transport for the life
 * of the connection, so a fresh instance per session is the documented
 * pattern rather than a shared singleton.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/index";

export const MCP_SERVER_NAME = "personal-calendar";
export const MCP_SERVER_VERSION = "0.1.0";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });

  registerTools(server);

  return server;
}
