/**
 * `ping` — trivial placeholder tool proving the MCP skeleton is wired end to
 * end (registration, transport, auth). Takes no arguments.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPingTool(server: McpServer): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description:
        "Health-check placeholder tool for the MCP server skeleton (T6). Returns { ok: true, time }.",
      inputSchema: {},
    },
    async () => {
      const payload = { ok: true, time: new Date().toISOString() };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  );
}
