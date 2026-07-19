/**
 * `list_grooming_tasks` (T7) — read-only view of the T8 weekly grooming
 * routine for a given date. This is a static, single-user routine (skincare,
 * shaving, biweekly feet care, etc.), NOT a mutable Google source, so there is
 * intentionally no create/update/delete here — the routine is defined in code
 * (`grooming/schedule.ts`). `get_day` also merges these into its `grooming`
 * array; this tool exposes them standalone.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getGroomingTasks } from "../../grooming/schedule";
import { jsonResult, errorResult } from "./context";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerGroomingTools(server: McpServer): void {
  server.registerTool(
    "list_grooming_tasks",
    {
      title: "List Grooming Tasks",
      description:
        "Return the read-only weekly grooming routine tasks for a date (YYYY-MM-DD), sorted AM→PM.",
      inputSchema: {
        date: z.string().regex(DATE_RE, "date must be YYYY-MM-DD"),
      },
    },
    async ({ date }) => {
      try {
        const [y, m, d] = date.split("-").map(Number);
        const grooming = getGroomingTasks(new Date(y, m - 1, d));
        return jsonResult({ date, grooming });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
