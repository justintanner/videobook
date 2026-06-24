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
  const provider = createKie({ apiKey: args.apiKey, timeout: args.timeout ?? 240_000 });
  const call = withRetry<KieGemini35FlashStreamGenerateContentRequest, KieGemini35FlashStreamGenerateContentResult>(
    provider.gemini.post.v1.models.gemini35Flash.streamGenerateContent,
    { retries: 2, baseMs: 500 },
  );

  const generationConfig: Record<string, unknown> = {};
  if (args.temperature !== undefined) generationConfig.temperature = args.temperature;
  if (args.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = args.maxOutputTokens;
  if (args.responseMimeType !== undefined) generationConfig.responseMimeType = args.responseMimeType;
  if (args.responseSchema !== undefined) generationConfig.responseSchema = args.responseSchema;

  const result = await call({
    stream: false,
    contents: [{ role: "user", parts: args.parts }],
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  }, args.signal);

  return firstGeminiFlashContent(result);
}

export function callGeminiFlashJson(args: Omit<GeminiFlashRequest, "responseMimeType">): Promise<string> {
  return callGeminiFlash({ ...args, responseMimeType: "application/json" });
}
