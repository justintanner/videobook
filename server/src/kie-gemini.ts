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
};

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

export async function firstGeminiFlashContent(result: KieGemini35FlashStreamGenerateContentResult): Promise<string> {
  if (!isGeminiFlashAsyncIterable(result)) return geminiFlashResponseText(result);

  let text = "";
  for await (const chunk of result) {
    text += geminiFlashResponseText(chunk);
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

  const result = await call({
    stream: false,
    contents: [{ role: "user", parts: args.parts }],
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  }, args.signal);

  const text = await firstGeminiFlashContent(result);
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
  const outputText = await callGeminiFlash(args);
  return normalizeGeminiJsonText(outputText);
}
