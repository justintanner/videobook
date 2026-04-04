import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

/** Read-only / polling tools that should not appear in the activity log. */
const EXCLUDED_ACTIONS = new Set([
  "tool-sync",
  "tool-list-assets",
  "tool-list-projects",
  "tool-get-default-project",
  "tool-asset-manifest",
  "tool-asset-history",
  "tool-project-history",
  "tool-project-activity",
  "tool-get-timeline",
  "tool-render-settings",
  "tool-api-status",
  "tool-sleep",
  "tool-slugs",
  "tool-list-chat-history",
  "tool-show-folder",
  "tool-commands",
  "tool-push_chat_history",
  "tool-preview_video",
  "tool-preview_image",
  "tool-translate_payload",
  "tool-update_script",
]);

export function projectActivityDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "project_activity",
    description: "Get the action log for a project (user-initiated actions like generate, render, upload, etc.)",
    schema: {
      project_slug: z.string().describe("Project slug"),
      limit: z.number().optional().describe("Max entries to return (default 50)"),
    },
    handler: async (args) => {
      const { project_slug, limit } = args as { project_slug: string; limit?: number };
      // Fetch more than needed so we have enough after filtering
      const raw = await fs.getActionLog({ limit: (limit ?? 50) * 3 }, project_slug);
      const filtered = raw
        .filter((e) => !EXCLUDED_ACTIONS.has(e.action))
        .slice(0, limit ?? 50);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(filtered),
        }],
      };
    },
  };
}
