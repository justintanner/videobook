import {
  classifyNotebookReference,
  normalizeNotebookReference,
} from "videobook-engine/notebook-mentions";

export const PREVIEW_PLACEHOLDER_HOST = "url.resolved.later.for";
export const PREVIEW_PLACEHOLDER_ORIGIN = `http://${PREVIEW_PLACEHOLDER_HOST}`;

const URL_FIELD_KEYS = new Set([
  "image_urls",
  "image_url",
  "reference_image",
  "reference_image_urls",
  "reference_images",
  "reference_video_urls",
  "reference_audio_urls",
  "video_url",
  "video_urls",
  "first_frame_url",
  "last_frame_url",
  "first_frame",
  "last_frame",
  "audio_url",
  "audio_urls",
  "character_image_urls",
  "motion_video_urls",
  "driving_audio_url",
  "start_image",
  "end_image",
]);
export const LOCAL_ASSET_SLUG_PREFIXES = [
  "aud",
  "char",
  "img",
  "nb",
  "prompt",
  "scene",
  "script",
  "vid",
] as const;
const LOCAL_ASSET_PREFIXES = new Set<string>(LOCAL_ASSET_SLUG_PREFIXES);

export interface PreviewUrlPlaceholder {
  path: string;
  reference: string;
  url: string;
}

export function previewPlaceholderUrl(reference: string): string {
  const bare = normalizeNotebookReference(reference);
  return `${PREVIEW_PLACEHOLDER_ORIGIN}/${encodeURIComponent(bare)}`;
}

export function isPreviewPlaceholderUrl(value: string): boolean {
  try {
    return new URL(value).host === PREVIEW_PLACEHOLDER_HOST;
  } catch {
    return false;
  }
}

function isUrlishKey(key: string): boolean {
  if (URL_FIELD_KEYS.has(key)) return true;
  if (key.endsWith("_url") || key.endsWith("_urls")) return true;
  return key === "image"
    || key === "images"
    || key === "video"
    || key === "videos"
    || key === "audio"
    || key === "audios";
}

function localReference(value: string): string | null {
  if (/^https?:\/\//iu.test(value)) return null;
  const reference = normalizeNotebookReference(value);
  const prefix = reference.split("-", 1)[0];
  return classifyNotebookReference(reference) === "asset-slug"
    && prefix
    && LOCAL_ASSET_PREFIXES.has(prefix)
    ? reference
    : null;
}

function transformValue(
  value: unknown,
  key: string,
  path: string,
  placeholders: PreviewUrlPlaceholder[],
): unknown {
  if (typeof value === "string") {
    if (!isUrlishKey(key)) return value;
    const reference = localReference(value);
    if (!reference) return value;
    const url = previewPlaceholderUrl(reference);
    placeholders.push({ path, reference: `@${reference}`, url });
    return url;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      transformValue(item, key, `${path}[${index}]`, placeholders));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      transformValue(
        childValue,
        childKey,
        path ? `${path}.${childKey}` : childKey,
        placeholders,
      ),
    ]),
  );
}

export function applyPreviewPlaceholderUrls(
  payload: Record<string, unknown>,
): {
  payload: Record<string, unknown>;
  placeholders: PreviewUrlPlaceholder[];
} {
  const placeholders: PreviewUrlPlaceholder[] = [];
  const transformed = transformValue(payload, "", "", placeholders);
  return {
    payload: transformed as Record<string, unknown>,
    placeholders,
  };
}
