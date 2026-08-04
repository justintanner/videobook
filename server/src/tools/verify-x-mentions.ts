import type { OpenAiResponseResponse } from "@apicity/openai";
import { z } from "zod";
import { toolError } from "./_shared.js";
import type { ToolDef } from "./tool-def.js";
import {
  INTELLIGENCE_MODEL,
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
  type ResponsesFn,
} from "../openai-intelligence.js";

export const MENTION_VERIFICATION_MODEL = INTELLIGENCE_MODEL;
const XAI_TIMEOUT_MS = 60_000;
const MAX_MENTIONS = 10;
const MAX_TEXT_CHARS = 1_000;

export type XMentionVerdict = {
  handle: string;
  exists: boolean | null;
  display_name: string | null;
  summary: string | null;
};

export type XMentionVerification = {
  mentions: XMentionVerdict[];
  citations: string[];
  model: string;
};

/** Extract unique X handles from post text. X usernames are 1-15 chars of
 *  [A-Za-z0-9_]; tokens followed by a hyphen (asset slugs like @vid-clip) and
 *  email-style @s preceded by a word character are excluded. */
export function extractXMentions(text: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/(^|[^\w@])@([A-Za-z0-9_]{1,15})(?![\w-])/g)) {
    const handle = match[2];
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push(handle);
  }
  return handles;
}

const VERDICTS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    mentions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          handle: { type: "string" },
          exists: { type: ["boolean", "null"] },
          display_name: { type: ["string", "null"] },
          summary: { type: ["string", "null"] },
        },
        required: ["handle", "exists", "display_name", "summary"],
      },
    },
  },
  required: ["mentions"],
};

const VERIFY_INSTRUCTIONS = [
  "You verify X (Twitter) handles using web search.",
  "For each handle, determine whether an account with EXACTLY that username exists on X.",
  "Usernames are case-insensitive; ignore lookalike or similar usernames.",
  "Set exists=true only when you confirm the exact username.",
  "Set exists=false only when search results positively indicate the username is nonexistent, unclaimed, or suspended.",
  "When you can neither confirm nor refute the exact profile (for example a small account you cannot load), set exists=null.",
  "display_name is the account's current display name and summary is one short sentence about the account from its bio or posts; use null for either when unknown.",
  "Never guess.",
].join(" ");

function responseText(response: OpenAiResponseResponse): { text: string; citations: string[] } {
  const citations: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type !== "output_text") continue;
      for (const annotation of content.annotations ?? []) {
        if (annotation.type === "url_citation" && annotation.url && !citations.includes(annotation.url)) {
          citations.push(annotation.url);
        }
      }
    }
  }
  return { text: firstResponseText(response), citations };
}

export async function verifyXMentionsWithOpenAi(
  responses: ResponsesFn,
  handles: string[],
  signal?: AbortSignal,
): Promise<XMentionVerification> {
  const response = await responses(intelligenceRequest({
    input: [
      { role: "user", content: `Verify these X handles: ${handles.map((handle) => `@${handle}`).join(", ")}` },
    ],
    instructions: VERIFY_INSTRUCTIONS,
    tools: [{ type: "web_search_preview" }],
    text: {
      format: {
        type: "json_schema",
        name: "x_mention_verdicts",
        schema: VERDICTS_JSON_SCHEMA,
        strict: true,
      },
    },
  }), signal);

  const { text, citations } = responseText(response);
  const parsed = JSON.parse(text) as { mentions?: XMentionVerdict[] };
  if (!Array.isArray(parsed.mentions)) {
    throw new Error("OpenAI verification response is missing the mentions array");
  }

  const byHandle = new Map(parsed.mentions.map((verdict) => [verdict.handle.replace(/^@/, "").toLowerCase(), verdict]));
  const mentions = handles.map((handle) => {
    const verdict = byHandle.get(handle.toLowerCase());
    return {
      handle,
      exists: verdict?.exists ?? null,
      display_name: verdict?.display_name ?? null,
      summary: verdict?.summary ?? null,
    };
  });
  return { mentions, citations, model: response.model };
}

export function verifyXMentionsDef(): ToolDef {
  return {
    name: "verify_x_mentions",
    description: "Verify that @-mentions in post text are real X (Twitter) accounts using OpenAI web search. Returns per-handle verdicts (exists true/false/null) with display names and one-line summaries.",
    schema: {
      text: z.string().min(1).max(MAX_TEXT_CHARS).describe("Post text containing @handles to verify"),
      book_id: z.string().describe("Book id"),
    },
    handler: async (args) => {
      const { text } = args as { text: string; book_id: string };

      if (!process.env.OPENAI_API_KEY) {
        return toolError("OPENAI_API_KEY environment variable is not set");
      }

      const handles = extractXMentions(text).slice(0, MAX_MENTIONS);
      if (handles.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ mentions: [], citations: [], model: MENTION_VERIFICATION_MODEL }),
          }],
        };
      }

      const responses = buildIntelligenceResponses(process.env.OPENAI_API_KEY, {
        timeout: XAI_TIMEOUT_MS,
      });
      try {
        const verification = await verifyXMentionsWithOpenAi(responses, handles);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(verification) }],
        };
      } catch (error) {
        return toolError(`Mention verification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
