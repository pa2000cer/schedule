/**
 * In-process MCP client↔server pair (T12).
 *
 * The T7 tools are exposed through an `McpServer`. To *call* them from within
 * the same Node process — without opening an HTTP transport to ourselves — we
 * wire an MCP `Client` to a fresh `createMcpServer()` over an in-memory,
 * linked transport pair. This is the exact pattern the T7 smoke harness
 * (`scripts/mcp-crud-smoke.ts`) uses; here it is factored out so both the
 * agentic assistant (`assistant/agent.ts`) and the `/api/day` route can reuse
 * one code path and one JSON-unwrapping convention.
 *
 * Auth is orthogonal: the caller sets the per-request Google tokens via
 * `setToolAuth(...)` (see `mcp/tools/context.ts`) BEFORE invoking tools, and
 * clears it afterwards. This helper only owns the transport plumbing.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server";

/** A tool as advertised by the MCP server (name + JSON-Schema input). */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** A connected in-process client with convenience wrappers. */
export interface InProcessMcp {
  /** The raw MCP client, for callers that need `callTool`/`listTools` directly. */
  client: Client;
  /**
   * Call a tool and unwrap its first text content block to `{ text, isError }`.
   * The registered T7 tools always return a single JSON text block (see
   * `mcp/tools/context.ts` `jsonResult`/`errorResult`), so `text` is JSON.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** List the advertised tools (name, description, JSON-Schema inputSchema). */
  listTools(): Promise<McpToolInfo[]>;
  /** Tear down both client and server transports. Safe to call once. */
  close(): Promise<void>;
}

/** Connect an in-process MCP client to a fresh server instance. */
export async function connectInProcessMcp(): Promise<InProcessMcp> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "personal-calendar-inproc", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    async callTool(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      };
      const text = res.content?.[0]?.text ?? "{}";
      return { text, isError: Boolean(res.isError) };
    },
    async listTools() {
      const res = await client.listTools();
      return res.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
    async close() {
      try {
        await client.close();
      } catch {
        /* ignore transport-close races */
      }
      try {
        await server.close();
      } catch {
        /* ignore transport-close races */
      }
    },
  };
}
