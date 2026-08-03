import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { PROMPT_SURFACES, isPromptSurface } from "../prompt-surfaces.js";

const SURFACE_LIST = PROMPT_SURFACES.join(", ");
const MAX_HISTORY_PAGE_SIZE = 1000;

function invalidSurface(value: unknown) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: `Invalid surface "${String(value)}". Expected one of: ${SURFACE_LIST}`,
      },
    ],
  };
}

export function recordPromptDef(fs: Engine): ToolDef {
  return {
    name: "record_prompt",
    description:
      "Append a user-typed prompt to the per-surface, per-project Dolt history. " +
      "Surfaces: " +
      SURFACE_LIST +
      ".",
    schema: {
      book_id: z.string().describe("Project slug"),
      surface: z
        .string()
        .describe(
          `Which input surface generated this prompt (${SURFACE_LIST})`,
        ),
      prompt: z.string().describe("The raw user-typed prompt to store"),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Optional params blob captured alongside the prompt (model, variant, platform, ...)",
        ),
    },
    handler: async (args) => {
      const { surface, prompt, params } = args as {
        surface: string;
        prompt: string;
        params?: Record<string, unknown>;
      };
      if (!isPromptSurface(surface)) return invalidSurface(surface);
      if (!prompt.trim()) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ id: null }) },
          ],
        };
      }
      const result = await fs.prompts.record({
        surface,
        prompt,
        ...(params ? { context: params } : {}),
      });
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ id: result.value.id }) },
        ],
      };
    },
  };
}

export function listPromptHistoryDef(fs: Engine): ToolDef {
  return {
    name: "list_prompt_history",
    description:
      "List recent prompts for a given surface in the current project, newest-first.",
    schema: {
      book_id: z.string().describe("Project slug"),
      surface: z
        .string()
        .describe(
          `Which input surface to read history for (${SURFACE_LIST})`,
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_HISTORY_PAGE_SIZE)
        .optional()
        .describe(`Max entries to return (default 100, capped at ${MAX_HISTORY_PAGE_SIZE})`),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Number of newer entries to skip"),
    },
    handler: async (args) => {
      const { surface, limit, offset } = args as {
        surface: string;
        limit?: number;
        offset?: number;
      };
      if (!isPromptSurface(surface)) return invalidSurface(surface);

      const pageLimit = limit ?? 100;
      const pageOffset = offset ?? 0;
      const entries = fs.prompts.list({
        surface,
        limit: pageOffset + pageLimit,
      });
      if (!entries.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: entries.error.message }],
        };
      }
      const count = fs.prompts.count({ surface });
      if (!count.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: count.error.message }],
        };
      }
      const pageEntries = entries.value.slice(pageOffset);
      const payload = pageEntries.map((entry) => ({
        id: entry.id,
        surface: entry.surface,
        prompt: entry.prompt,
        params: entry.context,
        created_at: entry.createdAt,
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              entries: payload,
              page: {
                offset: pageOffset,
                limit: pageLimit,
                total: count.value,
                has_more: pageOffset + pageEntries.length < count.value,
              },
            }),
          },
        ],
      };
    },
  };
}
