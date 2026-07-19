/**
 * Tag tools (T30) — the MCP "skill" for creating tags and applying them to events.
 *
 *   list_tags                         — the available tag names
 *   create_tag { name }               — add a tag to the available list
 *   delete_tag { name }               — remove a tag from the available list
 *   set_event_tags { id, tags }       — set the tags on a specific event
 *   add_event_tag { id, tag }         — add one tag to an event (keeps existing)
 *
 * Tags are a Firestore-only concept (not mirrored to Google). `set_event_tags`
 * and `add_event_tag` route through the store, so a recurring-instance id tags
 * just that occurrence.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getEvent, updateEvent } from "../../calendar/calendar";
import { getTags, addTag, removeTag } from "../../tags/tags";
import { getCalendarId, jsonResult, errorResult } from "./context";

export function registerTagTools(server: McpServer): void {
  server.registerTool(
    "list_tags",
    {
      title: "List Tags",
      description: "List the available tags that can be applied to events.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult({ tags: await getTags() });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "create_tag",
    {
      title: "Create Tag",
      description: "Add a new tag to the available list (e.g. a person's name).",
      inputSchema: { name: z.string().min(1).describe("The tag name.") },
    },
    async ({ name }) => {
      try {
        return jsonResult({ ok: true, tags: await addTag(name) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "delete_tag",
    {
      title: "Delete Tag",
      description: "Remove a tag from the available list.",
      inputSchema: { name: z.string().min(1).describe("The tag name to remove.") },
    },
    async ({ name }) => {
      try {
        return jsonResult({ ok: true, tags: await removeTag(name) });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "set_event_tags",
    {
      title: "Set Event Tags",
      description: "Replace the tags on a specific event (appointment/task) with the given list.",
      inputSchema: {
        id: z.string().min(1).describe("The event id (or recurring instance id)."),
        tags: z.array(z.string()).describe("The full set of tags for this event."),
      },
    },
    async ({ id, tags }) => {
      try {
        const item = await updateEvent(id, { tags }, getCalendarId());
        return jsonResult({ ok: true, event: item });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "add_event_tag",
    {
      title: "Add Event Tag",
      description: "Add one tag to an event, keeping its existing tags.",
      inputSchema: {
        id: z.string().min(1).describe("The event id (or recurring instance id)."),
        tag: z.string().min(1).describe("The tag to add."),
      },
    },
    async ({ id, tag }) => {
      try {
        const current = await getEvent(id, getCalendarId());
        const tags = Array.from(new Set([...(current.tags ?? []), tag]));
        const item = await updateEvent(id, { tags }, getCalendarId());
        return jsonResult({ ok: true, event: item });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
