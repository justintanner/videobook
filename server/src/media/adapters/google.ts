import crypto from "node:crypto";
import { extname } from "node:path";
import type {
  GoogleGenerateContentRequest,
  GoogleInteractionCreateRequest,
  GoogleInteractionResponse,
} from "@apicity/google";
import type { Engine } from "videobook-engine";
import { createGoogle } from "../../usage-providers.js";
import { getApiKey, requireApiKey } from "../../api-key.js";
import { providerEndpoints } from "../endpoints.js";
import { isGoogleInteractionModel } from "../google.js";
import { assetRef, readAssetRef } from "./asset-ref.js";
import type { ProviderAdapter, SubmitContext, SubmitResult } from "./types.js";

const IMAGE_TIMEOUT_MS = 3 * 60_000;
const VIDEO_TIMEOUT_MS = 6 * 60_000;

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const VIDEO_MIME_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpg",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
  ".3gp": "video/3gpp",
};

const OUTPUT_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
}

interface CachedOAuthToken {
  key: string;
  token: string;
  expiresAt: number;
}

let cachedToken: CachedOAuthToken | null = null;

function parseServiceAccount(raw: string): ServiceAccountJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  const sa = parsed as Partial<ServiceAccountJson>;
  if (!sa.client_email || !sa.private_key || !sa.token_uri) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email, private_key, and token_uri");
  }
  return sa as ServiceAccountJson;
}

function optionalServiceAccount(): ServiceAccountJson | null {
  const raw = getApiKey("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) return null;
  try {
    return parseServiceAccount(raw);
  } catch {
    return null;
  }
}

function resolveGoogleProject(sa?: ServiceAccountJson | null): string {
  const project = process.env.GOOGLE_CLOUD_PROJECT?.trim() || sa?.project_id?.trim() || optionalServiceAccount()?.project_id?.trim();
  if (!project) {
    throw new Error("Set GOOGLE_CLOUD_PROJECT (or GOOGLE_SERVICE_ACCOUNT_JSON with project_id) to call Vertex AI global routes");
  }
  return project;
}

async function mintGoogleOAuthToken(sa: ServiceAccountJson, signal?: AbortSignal): Promise<string> {
  const tokenUri = providerEndpoints().googleTokenURL ?? sa.token_uri;
  const cacheKey = `${sa.client_email}:${tokenUri}`;
  if (cachedToken && cachedToken.key === cacheKey && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const now = Math.floor(Date.now() / 1000);
  const b64u = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = b64u({ alg: "RS256", typ: "JWT" });
  const claim = b64u({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  });
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${claim}`)
    .sign(sa.private_key, "base64url");
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${signature}`,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to mint Google OAuth2 access token (${response.status})`);
  }
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Google OAuth2 token response omitted access_token");
  cachedToken = {
    key: cacheKey,
    token: body.access_token,
    expiresAt: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
  };
  return body.access_token;
}

export function resetGoogleOAuthTokenCache(): void {
  cachedToken = null;
}

async function inlineAsset(engine: Engine, ref: string, kind: "image" | "video"): Promise<{ data: string; mimeType: string }> {
  if (!ref.startsWith("asset://")) {
    throw new Error(`Google Vertex takes ${kind}s from this book, not a URL: ${ref}`);
  }
  const { bytes, filename } = await readAssetRef(engine, ref);
  const table = kind === "image" ? IMAGE_MIME_TYPES : VIDEO_MIME_TYPES;
  const mimeType = table[extname(filename).toLowerCase()];
  if (!mimeType) throw new Error(`Google Vertex does not accept ${filename} as a ${kind}`);
  return { data: bytes.toString("base64"), mimeType };
}

export interface GoogleMediaResult {
  taskId: string;
  outputs: Array<{ bytes: Buffer; extension: string }>;
}

export async function runGoogleImage(
  engine: Engine,
  apiId: string,
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GoogleMediaResult> {
  const apiKey = requireApiKey("GOOGLE_API_KEY");
  const project = resolveGoogleProject();
  const baseURL = providerEndpoints().googleBaseURL;
  const provider = createGoogle({ apiKey, timeout: IMAGE_TIMEOUT_MS, ...(baseURL ? { baseURL } : {}) });
  const contents = Array.isArray(request.contents) ? request.contents as Array<{ role?: string; parts?: Array<Record<string, unknown>> }> : [];
  const hydratedContents = await Promise.all(contents.map(async (entry) => ({
    ...entry,
    parts: await Promise.all((entry.parts ?? []).map(async (part) => {
      const inline = part.inlineData as { data?: unknown; mimeType?: unknown } | undefined;
      if (inline && typeof inline.data === "string" && inline.data.startsWith("asset://")) {
        const { data, mimeType } = await inlineAsset(engine, inline.data, "image");
        return { ...part, inlineData: { mimeType, data } };
      }
      return part;
    })),
  })));
  const response = await provider.v1.projects.locations.global.publishers.google.models.generateContent(
    project,
    apiId,
    { ...request, contents: hydratedContents } as unknown as GoogleGenerateContentRequest,
    signal,
  );
  const outputs = (response.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .flatMap((part) => {
      const mime = part.inlineData?.mimeType;
      const data = part.inlineData?.data;
      const extension = mime ? OUTPUT_EXTENSIONS[mime.toLowerCase()] : undefined;
      return data && extension ? [{ bytes: Buffer.from(data, "base64"), extension }] : [];
    });
  if (outputs.length === 0) throw new Error(`Google ${apiId} returned no image`);
  return { taskId: response.responseId ?? `${apiId}-${Date.now()}`, outputs };
}

function interactionVideos(response: GoogleInteractionResponse): Array<{ bytes: Buffer; extension: string }> {
  const outputs: Array<{ bytes: Buffer; extension: string }> = [];
  for (const step of response.steps ?? []) {
    if (!("content" in step) || !Array.isArray(step.content)) continue;
    for (const part of step.content) {
      if (part.type !== "video" || typeof part.data !== "string" || !part.data) continue;
      const extension = OUTPUT_EXTENSIONS[(part.mime_type ?? "video/mp4").toLowerCase()] ?? "mp4";
      outputs.push({ bytes: Buffer.from(part.data, "base64"), extension });
    }
  }
  return outputs;
}

async function runGoogleInteraction(
  engine: Engine,
  apiId: string,
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<GoogleMediaResult> {
  const sa = parseServiceAccount(requireApiKey("GOOGLE_SERVICE_ACCOUNT_JSON"));
  const project = resolveGoogleProject(sa);
  const oauthToken = await mintGoogleOAuthToken(sa, signal);
  const baseURL = providerEndpoints().googleBaseURL;
  const provider = createGoogle({ apiKey: "", oauthToken, timeout: VIDEO_TIMEOUT_MS, ...(baseURL ? { baseURL } : {}) });
  const steps = Array.isArray(request.input) ? request.input as Array<{ type?: string; content?: Array<Record<string, unknown>> }> : [];
  const hydratedInput = await Promise.all(steps.map(async (step) => ({
    ...step,
    content: await Promise.all((step.content ?? []).map(async (part) => {
      if ((part.type === "image" || part.type === "video") && typeof part.data === "string" && part.data.startsWith("asset://")) {
        const { data, mimeType } = await inlineAsset(engine, part.data, part.type);
        return { ...part, data, mime_type: mimeType };
      }
      return part;
    })),
  })));
  const response = await provider.v1.projects.locations.global.interactions(
    project,
    { ...request, input: hydratedInput } as unknown as GoogleInteractionCreateRequest,
    signal,
  );
  const outputs = interactionVideos(response);
  if (outputs.length === 0) {
    throw new Error(`Google ${apiId} returned no video (status ${response.status ?? "unknown"})`);
  }
  return { taskId: response.id ?? `${apiId}-${Date.now()}`, outputs };
}

export function googleAdapterFor(apiId: string): ProviderAdapter {
  const interaction = isGoogleInteractionModel(apiId);
  return {
    provider: "google",
    envKey: interaction ? "GOOGLE_SERVICE_ACCOUNT_JSON" : "GOOGLE_API_KEY",
    upload: async (_engine, assetId, filename) => assetRef(assetId, filename),
    uploadUrl: async (url) => {
      throw new Error(`Google Vertex takes media from this book, not a URL: ${url}`);
    },
    submit: async (request, context: SubmitContext): Promise<SubmitResult> => {
      const result = interaction
        ? await runGoogleInteraction(context.engine, apiId, request, context.ctx.signal)
        : await runGoogleImage(context.engine, apiId, request, context.ctx.signal);
      return { kind: "done", taskId: result.taskId, outputs: result.outputs };
    },
  };
}
