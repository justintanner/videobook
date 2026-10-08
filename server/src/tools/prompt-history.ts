import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { PROMPT_SURFACES, isPromptSurface, type PromptSurface } from "../prompt-surfaces.js";
import { listBookEngines } from "../queue.js";

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

export function recordPromptDef(engine: Engine): ToolDef {
  return {
    name: "record_prompt",
    description:
      "Append a user-typed prompt to the per-surface, per-project Dolt history. " +
      "Surfaces: " +
      SURFACE_LIST +
      ".",
    schema: {
      book_id: z.string().describe("Book id"),
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
      const result = await engine.prompts.record({
        surface,
        prompt,
        ...(params ? { context: params } : {}),
      });
      if (!result.ok) return errorResult(result.error.message);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ id: result.value.id }) },
        ],
      };
    },
  };
}

interface PromptHistoryPayloadEntry {
  id: string;
  surface: string;
  prompt: string;
  params: Record<string, unknown>;
  created_at: number;
  book: string;
}

interface PromptHistoryPage {
  entries: PromptHistoryPayloadEntry[];
  total: number;
}

type PromptHistoryScope = "book" | "library";

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function readBookPrompts(
  engine: Engine,
  surface: PromptSurface | undefined,
  limit: number,
): PromptHistoryPage | string {
  const filter = surface ? { surface } : {};
  const entries = engine.prompts.list({ ...filter, limit });
  if (!entries.ok) return entries.error.message;
  const count = engine.prompts.count(filter);
  if (!count.ok) return count.error.message;
  const book = engine.book.get().name;
  return {
    total: count.value,
    entries: entries.value.map((entry) => ({
      id: entry.id,
      surface: entry.surface,
      prompt: entry.prompt,
      params: entry.context,
      created_at: entry.createdAt,
      book,
    })),
  };
}

function mergePromptPages(pages: readonly PromptHistoryPage[]): PromptHistoryPage {
  return {
    total: pages.reduce((sum, page) => sum + page.total, 0),
    entries: pages
      .flatMap((page) => page.entries)
      .sort((left, right) => right.created_at - left.created_at),
  };
}

async function scopeEngines(
  engine: Engine,
  scope: PromptHistoryScope,
): Promise<Engine[]> {
  if (scope === "book") return [engine];
  const engines = await listBookEngines();
  return engines.includes(engine) ? engines : [engine, ...engines];
}

export function listPromptHistoryDef(engine: Engine): ToolDef {
  return {
    name: "list_prompt_history",
    description:
      "List recent prompts newest-first, for one surface or every surface, in the current book or across the whole library.",
    schema: {
      book_id: z.string().describe("Book id"),
      surface: z
        .string()
        .optional()
        .describe(
          `Which input surface to read history for (${SURFACE_LIST}); omit for every surface`,
        ),
      scope: z
        .enum(["book", "library"])
        .optional()
        .describe("book (default) reads this book; library reads every book in the library"),
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
      const { surface, scope, limit, offset } = args as {
        surface?: string;
        scope?: PromptHistoryScope;
        limit?: number;
        offset?: number;
      };
      if (surface !== undefined && !isPromptSurface(surface)) {
        return invalidSurface(surface);
      }
      const pageLimit = limit ?? 100;
      const pageOffset = offset ?? 0;
      const pages: PromptHistoryPage[] = [];
      for (const bookEngine of await scopeEngines(engine, scope ?? "book")) {
        const page = readBookPrompts(bookEngine, surface, pageOffset + pageLimit);
        if (typeof page === "string") return errorResult(page);
        pages.push(page);
      }
      const merged = mergePromptPages(pages);
      const pageEntries = merged.entries.slice(pageOffset, pageOffset + pageLimit);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              entries: pageEntries,
              page: {
                offset: pageOffset,
                limit: pageLimit,
                total: merged.total,
                has_more: pageOffset + pageEntries.length < merged.total,
              },
            }),
          },
        ],
      };
    },
  };
}
