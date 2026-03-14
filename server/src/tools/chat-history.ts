import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function pushChatHistoryDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "push_chat_history",
    description: "Append a message to the chat input history log.",
    schema: {
      message: z.string().describe("The chat message to store"),
      project_slug: z
        .string()
        .optional()
        .describe("Project slug (defaults to 'default')"),
    },
    handler: async (args) => {
      const { message, project_slug } = args as {
        message: string;
        project_slug?: string;
      };
      const slug = project_slug ?? "default";
      const result = await fs.appendLog(
        "chat-input-history",
        { message, ts: Date.now() },
        slug,
      );
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
      };
    },
  };
}

export function listChatHistoryDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "list_chat_history",
    description: "List recent chat input history entries.",
    schema: {
      project_slug: z
        .string()
        .optional()
        .describe("Project slug (defaults to 'default')"),
      limit: z
        .number()
        .optional()
        .describe("Max entries to return (default 100)"),
    },
    handler: async (args) => {
      const { project_slug, limit } = args as {
        project_slug?: string;
        limit?: number;
      };
      const slug = project_slug ?? "default";
      const entries = await fs.readLog("chat-input-history", slug, {
        limit: limit ?? 100,
      });
      const messages = entries
        .map((e) => e.message as string)
        .filter(Boolean);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ messages }) },
        ],
      };
    },
  };
}
