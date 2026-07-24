import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function pushChatHistoryDef(fs: Engine): ToolDef {
  return {
    name: "push_chat_history",
    description: "Append a message to the chat input history log.",
    schema: {
      message: z.string().describe("The chat message to store"),
      book_id: z
        .string()
        .describe("Project slug"),
    },
    handler: async (args) => {
      const { message } = args as {
        message: string;
      };
      const result = await fs.logs.append(
        "chat-input-history",
        { message, ts: Date.now() },
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

export function listChatHistoryDef(fs: Engine): ToolDef {
  return {
    name: "list_chat_history",
    description: "List recent chat input history entries.",
    schema: {
      book_id: z
        .string()
        .describe("Project slug"),
      limit: z
        .number()
        .optional()
        .describe("Max entries to return (default 100)"),
    },
    handler: async (args) => {
      const { limit } = args as {
        limit?: number;
      };
      const entries = fs.logs.read("chat-input-history", {
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
