import { createKie, withRetry } from "@apicity/kie";
import type {
  KieGemini35FlashGenerateContentResponse,
  KieGemini35FlashStreamGenerateContentChunk,
  KieGemini35FlashStreamGenerateContentRequest,
  KieGemini35FlashStreamGenerateContentResult,
  KieGeminiPart,
} from "@apicity/kie";

export const KIE_GEMINI_FLASH_MODEL = "gemini-3-5-flash";

type JsonSchema = Record<string, unknown>;

type GeminiFlashRequest = {
  apiKey: string;
  parts: KieGeminiPart[];
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: JsonSchema;
  timeout?: number;
  signal?: AbortSignal;
  // When provided, the request streams and this fires with the cumulative text
  // after each chunk (for live "show your work" previews). Omitted = one-shot.
  onDelta?: (textSoFar: string) => void;
};

// Gemini's responseSchema accepts only the OpenAPI 3.0 Schema subset; JSON-Schema
// keywords outside it (notably `additionalProperties`, `$schema`) make Google
// reject the whole request. Strip them recursively so a schema authored for our
// own Zod-side validation can be reused verbatim as a Gemini responseSchema.
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set(["additionalProperties", "$schema"]);

export function toGeminiResponseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiResponseSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    result[key] = toGeminiResponseSchema(value);
  }
  return result;
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function geminiFlashAuthFetch(apiKey: string, doFetch: typeof fetch = fetch): typeof fetch {
  return (async (input, init) => {
    const url = fetchInputUrl(input);
    if (!url.includes("/gemini/v1/models/gemini-3-5-flash:streamGenerateContent")) {
      return doFetch(input, init);
    }

    const requestHeaders = typeof input === "string" || input instanceof URL ? undefined : input.headers;
    const headers = new Headers(init?.headers ?? requestHeaders);
    headers.delete("X-Goog-Api-Key");
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.set("Content-Type", "application/json");
    return doFetch(input, { ...init, headers });
  }) as typeof fetch;
}

export function geminiTextPart(text: string): KieGeminiPart {
  return { text };
}

export function geminiImageBase64Part(base64: string, mimeType: string): KieGeminiPart {
  return { inline_data: { mime_type: mimeType, data: base64 } };
}

export function geminiImageDataUrlPart(dataUrl: string): KieGeminiPart {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (match) return geminiImageBase64Part(match[2], match[1]);
  return { file_data: { mime_type: "application/octet-stream", file_uri: dataUrl } };
}

export function isGeminiFlashAsyncIterable(
  result: KieGemini35FlashStreamGenerateContentResult,
): result is AsyncIterable<KieGemini35FlashStreamGenerateContentChunk> {
  const maybeIterable = result as { [Symbol.asyncIterator]?: unknown };
  return typeof maybeIterable[Symbol.asyncIterator] === "function";
}

export function geminiFlashResponseText(response: KieGemini35FlashGenerateContentResponse): string {
  const envelope = response as { code?: unknown; msg?: unknown; message?: unknown };
  if (typeof envelope.code === "number" && envelope.code !== 0 && envelope.code !== 200) {
    const message = typeof envelope.msg === "string"
      ? envelope.msg
      : typeof envelope.message === "string" ? envelope.message : "request failed";
    throw new Error(`Kie Gemini API error ${envelope.code}: ${message}`);
  }

  return (response.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();
}

// Collect the full text from a Gemini result, whether it's a single response
// (stream:false) or an async iterable of SSE chunks (stream:true). When the
// result streams, `onDelta` fires with the cumulative text after each chunk.
export async function collectGeminiFlashContent(
  result: KieGemini35FlashStreamGenerateContentResult,
  onDelta?: (textSoFar: string) => void,
): Promise<string> {
  if (!isGeminiFlashAsyncIterable(result)) {
    const text = geminiFlashResponseText(result);
    onDelta?.(text);
    return text;
  }

  let text = "";
  for await (const chunk of result) {
    text += geminiFlashResponseText(chunk);
    onDelta?.(text);
  }
  return text.trim();
}

export async function callGeminiFlash(args: GeminiFlashRequest): Promise<string> {
  const provider = createKie({
    apiKey: args.apiKey,
    timeout: args.timeout ?? 240_000,
    fetch: geminiFlashAuthFetch(args.apiKey),
  });
  const call = withRetry<KieGemini35FlashStreamGenerateContentRequest, KieGemini35FlashStreamGenerateContentResult>(
    provider.gemini.post.v1.models.gemini35Flash.streamGenerateContent,
    { retries: 2, baseMs: 500 },
  );

  const generationConfig: Record<string, unknown> = {};
  if (args.temperature !== undefined) generationConfig.temperature = args.temperature;
  if (args.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = args.maxOutputTokens;
  if (args.responseMimeType !== undefined) generationConfig.responseMimeType = args.responseMimeType;
  if (args.responseSchema !== undefined) generationConfig.responseSchema = toGeminiResponseSchema(args.responseSchema);

  const result = await call({
    // Stream only when the caller wants progressive deltas; one-shot otherwise.
    stream: args.onDelta !== undefined,
    contents: [{ role: "user", parts: args.parts }],
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  }, args.signal);

  const text = await collectGeminiFlashContent(result, args.onDelta);
  if (text.length === 0) throw new Error("Kie Gemini returned no text content");
  return text;
}

export function normalizeGeminiJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) return fenced[1].trim();

  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const starts = [objectStart, arrayStart].filter((idx) => idx >= 0);
  if (starts.length === 0) return trimmed;

  const start = Math.min(...starts);
  const objectEnd = trimmed.lastIndexOf("}");
  const arrayEnd = trimmed.lastIndexOf("]");
  const end = Math.max(objectEnd, arrayEnd);
  if (start > 0 || end < trimmed.length - 1) {
    if (end > start) return trimmed.slice(start, end + 1).trim();
  }

  return trimmed;
}

export async function callGeminiFlashJson(args: Omit<GeminiFlashRequest, "responseMimeType">): Promise<string> {
  // application/json puts Gemini in structured-output mode: combined with an
  // optional responseSchema it returns a single parseable JSON value (no prose,
  // no markdown fences) rather than best-effort text we have to scrape. The
  // normalize step below stays as a safety net for models that ignore the hint.
  const outputText = await callGeminiFlash({ ...args, responseMimeType: "application/json" });
  return normalizeGeminiJsonText(outputText);
}
