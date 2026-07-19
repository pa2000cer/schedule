/**
 * Central tool registry. `createMcpServer` (see `../server.ts`) calls
 * `registerTools` once per new MCP session so every session gets the same
 * tool set.
 *
 * T7 registers the real calendar/task CRUD surface (full create/update/delete
 * on every element type). Every tool resolves the caller's Google auth through
 * the `./context` seam (`setToolAuth` / env fallback) — see [[Calendar MCP Server]].
 *
 * One file per closely-related tool group under this `tools/` folder:
 *   - `getDay.ts`       — get_day (merged one-day view)
 *   - `appointments.ts` — add/update/delete_appointment
 *   - `tasks.ts`        — add/update/complete/reschedule/delete_task
 *   - `recurring.ts`    — add/update/delete_recurring (instance vs. series)
 *   - `grooming.ts`     — list_grooming_tasks (read-only T8 routine)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPingTool } from "./ping";
import { registerGetDayTool } from "./getDay";
import { registerAppointmentTools } from "./appointments";
import { registerTaskTools } from "./tasks";
import { registerRecurringTools } from "./recurring";
import { registerGroomingTools } from "./grooming";
import { registerSyncTools } from "./sync";

export function registerTools(server: McpServer): void {
  registerPingTool(server);
  registerGetDayTool(server);
  registerAppointmentTools(server);
  registerTaskTools(server);
  registerRecurringTools(server);
  registerGroomingTools(server);
  registerSyncTools(server);
}
