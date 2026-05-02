import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { PROMPT_SURFACES, isPromptSurface } from "../prompt-surfaces.js";

const SURFACE_LIST = PROMPT_SURFACES.join(", ");

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

export function recordPromptDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "record_prompt",
    description:
      "Append a user-typed prompt to the per-surface, per-project history (metadata.sqlite). " +
      "Surfaces: " +
      SURFACE_LIST +
      ".",
    schema: {
      project_slug: z.string().describe("Project slug"),
      surface: z
        .string()
        .describe(
          "Which input surface generated this prompt (chat | image_rewrite | script_rewrite | post)",
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
      const { project_slug: slug, surface, prompt, params } = args as {
        project_slug: string;
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
      const result = await fs.recordPrompt(
        { surface, prompt, params },
        slug,
      );
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

async function maybeImportChatJsonl(
  fs: ClipfirstFs,
  slug: string,
): Promise<void> {
  const existing = await fs.countPromptHistory("chat", slug);
  if (existing > 0) return;
  const legacy = await fs.readLog("chat-input-history", slug, { limit: 1000 });
  if (legacy.length === 0) return;
  for (const entry of legacy) {
    const message = (entry as { message?: unknown }).message;
    if (typeof message !== "string" || !message.trim()) continue;
    await fs.recordPrompt({ surface: "chat", prompt: message }, slug);
  }
}

export function listPromptHistoryDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "list_prompt_history",
    description:
      "List recent prompts for a given surface in the current project, newest-first.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      surface: z
        .string()
        .describe(
          "Which input surface to read history for (chat | image_rewrite | script_rewrite | post)",
        ),
      limit: z
        .number()
        .optional()
        .describe("Max entries to return (default 100, capped at 1000)"),
    },
    handler: async (args) => {
      const { project_slug: slug, surface, limit } = args as {
        project_slug: string;
        surface: string;
        limit?: number;
      };
      if (!isPromptSurface(surface)) return invalidSurface(surface);

      if (surface === "chat") {
        try {
          await maybeImportChatJsonl(fs, slug);
        } catch {
          // Best-effort: don't fail the read if legacy log is unreadable.
        }
      }

      const entries = await fs.listPromptHistory(
        { surface, limit: limit ?? 100 },
        slug,
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ entries }) },
        ],
      };
    },
  };
}
