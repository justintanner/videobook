import type { Artifact, Engine, NotebookDocument } from "videobook-engine";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenAiContentPart } from "@apicity/openai";
import {
  isRenamable,
  humanizeSlug,
  buildSuggestionPrompt,
  parseSuggestionResponse,
  buildRenameRows,
  validateEditedRenames,
  applyableRows,
  rewriteDeep,
  isProcessOrigin,
  type RenameRow,
  type AssetContext,
  type EditedRename,
} from "../rename-helpers.js";
import { RENDER_ORIENTATIONS } from "./sync.js";
import type { ToolDef } from "./tool-def.js";
import {
  INTELLIGENCE_MODEL,
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "../openai-intelligence.js";
import {
  replaceNotebookMentions,
  scanNotebookMentions,
  stripNotebookMentions,
} from "videobook-engine/notebook-mentions";

interface RenamePayload {
  asset_id: string;
  suggested_name: string;
}

const schema = {
  book_id: z.string().describe("Project slug"),
  dry_run: z
    .boolean()
    .describe("true = preview only (no renames). false = apply the confirmed renames."),
  renames: z
    .array(
      z.object({
        asset_id: z.string(),
        suggested_name: z.string(),
      }),
    )
    .optional()
    .describe(
      "Edited renames for revalidation (dry_run:true) or confirmed renames to apply (dry_run:false). " +
        "Omit on the first dry run to let GPT-5.6 Sol propose names.",
    ),
};

export function renameAllDef(fs: Engine): ToolDef {
  return {
    name: "rename_all",
    description:
      "Bulk-rename vid-*/img-* assets with an explicit dry run. Dry run proposes descriptive names via GPT-5.6 Sol " +
      "over stored analysis/transcript/prompt context; re-run dry_run with edited `renames` to revalidate; " +
      "set dry_run=false to apply via fs.renameAsset and update timeline/OSG/plan references.",
    schema,
    handler: async (args) => {
      const { book_id, dry_run, renames } = args as {
        book_id: string;
        dry_run: boolean;
        renames?: RenamePayload[];
      };

      const assets = await fs.artifacts.list();
      const allAssetIds = assets.map((a) => a.slug);

      if (dry_run) {
        return renames && renames.length > 0
          ? handleDryRunRevalidation(renames, allAssetIds)
          : handleDryRunSuggest(fs, assets, book_id, allAssetIds);
      }

      if (!renames || renames.length === 0) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: "Applying requires a non-empty `renames` array. Run a dry run first.",
          }],
        };
      }

      return handleApply(fs, book_id, renames, allAssetIds);
    },
  };
}

async function handleDryRunSuggest(
  fs: Engine,
  assets: Artifact[],
  bookId: string,
  allAssetIds: string[],
): Promise<{ isError?: true; content: Array<{ type: "text"; text: string }> }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      isError: true as const,
      content: [{
        type: "text" as const,
        text: "OPENAI_API_KEY environment variable is not set",
      }],
    };
  }

  const candidates = assets.filter((a) => isRenamable(a.slug));
  if (candidates.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          dry_run: true,
          rows: [],
          note: "No vid/img assets found.",
        }),
      }],
    };
  }

  const contexts: AssetContext[] = [];
  for (const a of candidates) {
    const ctx = await loadAssetContext(fs, a.slug, a.kind, bookId);
    contexts.push(
      ctx ?? {
        asset_id: a.slug,
        type: a.slug.startsWith("vid-") ? "video" : "image",
        context_text: "",
      },
    );
  }

  const previews = await loadPreviewStills(fs, contexts, bookId);
  const hasImages = previews.some((p) => p.parts.length > 0);
  const contentParts = buildMultimodalContent(contexts, previews, hasImages);

  const responses = buildIntelligenceResponses(apiKey, { timeout: 120_000 });
  const result = await responses(intelligenceRequest({
    input: [{
      role: "user",
      content: responseContentFromChat(contentParts),
    }],
    text: { format: { type: "json_object" } },
    max_output_tokens: 2048,
  }));
  const suggestions = parseSuggestionResponse(firstResponseText(result));

  const rows = buildRenameRows(contexts, suggestions, allAssetIds);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ dry_run: true, rows, model: INTELLIGENCE_MODEL }),
    }],
  };
}

async function handleDryRunRevalidation(
  renames: RenamePayload[],
  allAssetIds: string[],
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const edits: EditedRename[] = renames.map((r) => ({
    asset_id: r.asset_id,
    suggested_name: r.suggested_name,
  }));
  const rows = validateEditedRenames(edits, allAssetIds);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ dry_run: true, rows }),
    }],
  };
}

async function handleApply(
  fs: Engine,
  bookId: string,
  renames: RenamePayload[],
  allAssetIds: string[],
): Promise<{ isError?: true; content: Array<{ type: "text"; text: string }> }> {
  const edits: EditedRename[] = renames.map((r) => ({
    asset_id: r.asset_id,
    suggested_name: r.suggested_name,
  }));
  const rows = validateEditedRenames(edits, allAssetIds);
  const toApply = applyableRows(rows);

  if (toApply.length === 0) {
    return {
      isError: true as const,
      content: [{
        type: "text" as const,
        text: "No renamable rows after validation. Resolve conflicts/skips and re-run the dry run.",
      }],
    };
  }

  const applied: Array<{
    asset_id: string;
    target_asset_id: string;
    new_asset_id: string;
    renamed: boolean;
    error?: string;
  }> = [];
  const idMap = new Map<string, string>();

  for (const row of toApply) {
    const result = await fs.artifacts.rename(row.asset_id, row.suggested_name);
    if (!result.ok) {
      applied.push({
        asset_id: row.asset_id,
        target_asset_id: row.target_asset_id,
        new_asset_id: row.asset_id,
        renamed: false,
        error: result.error.message,
      });
      continue;
    }
    idMap.set(row.asset_id, result.value.slug);
    applied.push({
      asset_id: row.asset_id,
      target_asset_id: row.target_asset_id,
      new_asset_id: result.value.slug,
      renamed: true,
    });
  }

  if (idMap.size > 0) {
    await updateReferences(fs, idMap);
  }

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ dry_run: false, applied, references_updated: idMap.size > 0 }),
    }],
  };
}

/** Load the stored context text used to drive GPT's name suggestion.
 *  Videos: visual analysis + generation prompt + short transcript.
 *  Images: analysis, generation prompt, and parent-video context for
 *  extracted frames. Returns null when no useful text is available. */
async function loadAssetContext(
  fs: Engine,
  assetId: string,
  type: string,
  bookId: string,
): Promise<AssetContext | null> {
  if (type === "video" || assetId.startsWith("vid-")) {
    return loadVideoContext(fs, assetId, bookId);
  }
  if (type === "image" || assetId.startsWith("img-")) {
    return loadImageContext(fs, assetId, bookId);
  }
  return null;
}

function decodeJsonBuffer(value: string | Buffer): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

/** Pull summary / subjects / setting / tags from `.original.analysis.json`. */
async function readAnalysisParts(
  fs: Engine,
  assetId: string,
  _bookId: string,
): Promise<string[]> {
  const parts: string[] = [];
  const analysisRead = await fs.files.read(assetId, ".original.analysis.json");
  if (!analysisRead.ok) return parts;
  try {
    const analysis = JSON.parse(decodeJsonBuffer(analysisRead.value)) as Record<string, unknown>;
    const summary = typeof analysis.summary === "string" ? analysis.summary : "";
    const subjects = Array.isArray(analysis.subjects) ? analysis.subjects.join(", ") : "";
    const setting = typeof analysis.setting === "string" ? analysis.setting : "";
    const tags = Array.isArray(analysis.tags) ? analysis.tags.join(", ") : "";
    const prompt = typeof analysis.prompt === "string" ? analysis.prompt : "";
    if (summary) parts.push(summary);
    if (subjects) parts.push(`subjects: ${subjects}`);
    if (setting) parts.push(`setting: ${setting}`);
    if (tags) parts.push(`tags: ${tags}`);
    // Image describe_image caches a reproduction prompt in analysis.
    if (prompt && !summary) parts.push(prompt.slice(0, 400));
  } catch {
    // ignore parse errors
  }
  return parts;
}

async function loadVideoContext(
  fs: Engine,
  assetId: string,
  bookId: string,
): Promise<AssetContext | null> {
  const parts: string[] = [];

  parts.push(...(await readAnalysisParts(fs, assetId, bookId)));

  // Generation prompt is often the richest description when analysis is missing.
  const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, "original");
  if (meta.ok) {
    const prompt = typeof meta.value.prompt === "string" ? meta.value.prompt.trim() : "";
    if (prompt) {
      // Strip long @refs so the model focuses on the scene description.
      const cleaned = stripNotebookMentions(
        prompt,
        scanNotebookMentions(prompt).map((mention) => mention.reference),
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
      if (cleaned) parts.push(`generation prompt: ${cleaned}`);
    }
  }

  // Transcript is secondary — cap length so it doesn't drown out visuals.
  for (const transFile of [".analysis.gpt4otrans.json", "elevenlabs.json"]) {
    const transRead = await fs.files.read(assetId, transFile);
    if (!transRead.ok) continue;
    try {
      const parsed = JSON.parse(decodeJsonBuffer(transRead.value)) as { text?: string };
      if (parsed.text && parsed.text.trim()) {
        const snippet = parsed.text.trim().replace(/\s+/g, " ").slice(0, 220);
        parts.push(`spoken: ${snippet}`);
        break;
      }
    } catch {
      // ignore
    }
  }

  if (parts.length === 0) return null;
  return { asset_id: assetId, type: "video", context_text: parts.join("\n") };
}

async function loadImageContext(
  fs: Engine,
  assetId: string,
  bookId: string,
): Promise<AssetContext | null> {
  const parts: string[] = [];
  parts.push(...(await readAnalysisParts(fs, assetId, bookId)));

  const meta = await fs.metadata.artifacts.read<Record<string, unknown>>(assetId, "original");
  if (meta.ok) {
    const origin = typeof meta.value.origin === "string" ? meta.value.origin : "";
    const prompt = typeof meta.value.prompt === "string" ? meta.value.prompt.trim() : "";
    const sourceAsset =
      typeof meta.value.source_asset === "string" ? meta.value.source_asset : "";
    const sourceAssets = Array.isArray(meta.value.source_assets)
      ? meta.value.source_assets.filter((s): s is string => typeof s === "string")
      : [];

    // Extracted frames: inherit the parent video's visual analysis, not "last_frame".
    if (sourceAsset && origin && /_frame$/i.test(origin)) {
      const parent = await loadVideoContext(fs, sourceAsset, bookId);
      if (parent?.context_text) {
        parts.push(`still from ${sourceAsset}: ${parent.context_text.slice(0, 400)}`);
      }
    } else if (sourceAssets.length > 0) {
      // Composite / edit images: briefly describe source materials, then edit intent.
      for (const src of sourceAssets.slice(0, 3)) {
        if (src.startsWith("vid-")) {
          const parent = await loadVideoContext(fs, src, bookId);
          if (parent?.context_text) {
            parts.push(`source ${src}: ${parent.context_text.slice(0, 200)}`);
          }
        } else if (src.startsWith("img-")) {
          const srcAnalysis = await readAnalysisParts(fs, src, bookId);
          if (srcAnalysis.length > 0) {
            parts.push(`source ${src}: ${srcAnalysis.join(" ").slice(0, 200)}`);
          } else {
            const srcMeta = await fs.metadata.artifacts.read<Record<string, unknown>>(src, "original"
            );
            if (srcMeta.ok) {
              const srcOrigin =
                typeof srcMeta.value.origin === "string" ? srcMeta.value.origin : "";
              const srcSource =
                typeof srcMeta.value.source_asset === "string"
                  ? srcMeta.value.source_asset
                  : "";
              if (srcSource && srcOrigin && /_frame$/i.test(srcOrigin)) {
                const parent = await loadVideoContext(fs, srcSource, bookId);
                if (parent?.context_text) {
                  parts.push(`source ${src}: ${parent.context_text.slice(0, 200)}`);
                }
              }
            }
          }
        }
      }
      if (prompt) {
        parts.push(`edit intent: ${prompt.slice(0, 300)}`);
      }
    } else if (prompt) {
      parts.push(prompt.slice(0, 500));
    }

    // Process origins (last_frame, external, …) are not naming signals.
    if (origin && !isProcessOrigin(origin)) {
      parts.push(`origin: ${origin}`);
    }
  }

  if (parts.length === 0) return null;
  return { asset_id: assetId, type: "image", context_text: parts.join("\n") };
}

// --- Vision previews --------------------------------------------------------

interface AssetPreview {
  asset_id: string;
  parts: OpenAiContentPart[];
}

const PREVIEW_CANDIDATES = [
  "square.jpg",
  "landscape.jpg",
  "original.jpg",
  "portrait.jpg",
  "original.png",
] as const;

/** Prefer first/last original_frames for videos; fall back to poster jpg. */
async function loadPreviewStills(
  fs: Engine,
  contexts: AssetContext[],
  bookId: string,
): Promise<AssetPreview[]> {
  const out: AssetPreview[] = [];
  for (const ctx of contexts) {
    const parts =
      ctx.type === "video" || ctx.asset_id.startsWith("vid-")
        ? await loadVideoPreviewParts(fs, ctx.asset_id, bookId)
        : await loadImagePreviewParts(fs, ctx.asset_id, bookId);
    out.push({ asset_id: ctx.asset_id, parts });
  }
  return out;
}

async function loadVideoPreviewParts(
  fs: Engine,
  assetId: string,
  bookId: string,
): Promise<OpenAiContentPart[]> {
  const frameParts = await loadEndFrameParts(fs, assetId, bookId);
  if (frameParts.length > 0) return frameParts;
  return loadImagePreviewParts(fs, assetId, bookId);
}

/** Read first + last jpg from original_frames via the asset dir on disk.
 *  Nested frame paths are not readable through fs.files.read(filename safety). */
async function loadEndFrameParts(
  fs: Engine,
  assetId: string,
  _bookId: string,
): Promise<OpenAiContentPart[]> {
  const manifest = await fs.files.manifest(assetId);
  if (!manifest.ok) return [];
  const frames = manifest.value.directories?.original_frames
    ?? manifest.value.directories?.landscape_frames
    ?? null;
  if (!frames || frames.length === 0) return [];

  const jpgs = frames.filter((f) => f.endsWith(".jpg")).sort((a, b) => {
    const ta = parseFloat(a.replace(/\.jpg$/i, "")) || 0;
    const tb = parseFloat(b.replace(/\.jpg$/i, "")) || 0;
    return ta - tb;
  });
  if (jpgs.length === 0) return [];

  const first = jpgs[0];
  const last = jpgs[jpgs.length - 1];
  const dirKey = manifest.value.directories?.original_frames
    ? "original_frames"
    : "landscape_frames";
  const picks = first === last ? [first] : [first, last];
  const parts: OpenAiContentPart[] = [];
  for (const name of picks) {
    try {
      const buf = await readFile(join(manifest.value.path, dirKey, name));
      parts.push(imagePartFromBuffer(buf, "image/jpeg"));
    } catch {
      // skip missing frame
    }
  }
  return parts;
}

async function loadImagePreviewParts(
  fs: Engine,
  assetId: string,
  _bookId: string,
): Promise<OpenAiContentPart[]> {
  for (const filename of PREVIEW_CANDIDATES) {
    const read = await fs.files.read(assetId, filename);
    if (!read.ok) continue;
    const buf = Buffer.isBuffer(read.value)
      ? read.value
      : Buffer.from(read.value);
    // Cap very large originals (~1.5MB decoded) so the request stays reasonable.
    if (buf.length > 1_500_000) continue;
    const mime = filename.endsWith(".png") ? "image/png" : "image/jpeg";
    return [imagePartFromBuffer(buf, mime)];
  }
  return [];
}

function imagePartFromBuffer(buf: Buffer, mime: string): OpenAiContentPart {
  return {
    type: "image_url",
    image_url: {
      url: `data:${mime};base64,${buf.toString("base64")}`,
      detail: "low",
    },
  };
}

/** Build multimodal chat content: instruction text + per-asset stills. */
function buildMultimodalContent(
  contexts: AssetContext[],
  previews: AssetPreview[],
  hasImages: boolean,
): OpenAiContentPart[] | string {
  const text = buildSuggestionPrompt(contexts, { hasImages });
  if (!hasImages) return text;

  const byId = new Map(previews.map((p) => [p.asset_id, p.parts]));
  const parts: OpenAiContentPart[] = [{ type: "text", text }];
  for (const ctx of contexts) {
    const images = byId.get(ctx.asset_id) ?? [];
    if (images.length === 0) continue;
    parts.push({
      type: "text",
      text: `Preview for ${ctx.asset_id}:`,
    });
    parts.push(...images);
  }
  return parts;
}

function responseContentFromChat(
  content: OpenAiContentPart[] | string,
): Array<
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" | "low" | "high" }
> {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  return content.map((part) => part.type === "text"
    ? { type: "input_text" as const, text: part.text }
    : {
        type: "input_image" as const,
        image_url: part.image_url.url,
        detail: part.image_url.detail ?? "auto",
      });
}

/** Rewrite first-class references after a batch rename: timeline slots/audio,
 *  per-asset OSG render metadata (osgAssetId), and plan/.plan.json ids. */
async function updateReferences(
  fs: Engine,
  idMap: Map<string, string>,
): Promise<void> {
  await updateOsgReferences(fs, idMap);
  await updateNotebookReferences(fs, idMap);
}

async function updateOsgReferences(
  fs: Engine,
  idMap: Map<string, string>,
): Promise<void> {
  const assets = await fs.artifacts.list();
  for (const asset of assets) {
    if (!asset.slug.startsWith("vid-")) continue;
    let changed = false;
    for (const orient of RENDER_ORIENTATIONS) {
      const metaKey = `${orient}.render`;
      const read = await fs.metadata.artifacts.read<Record<string, unknown>>(asset.slug, metaKey
      );
      if (!read.ok) continue;
      const osgId = read.value.osgAssetId;
      if (typeof osgId === "string" && idMap.has(osgId)) {
        read.value.osgAssetId = idMap.get(osgId);
        changed = true;
        await fs.metadata.artifacts.write(asset.slug, metaKey, read.value);
      }
    }
    void changed;
  }
}

async function updateNotebookReferences(
  fs: Engine,
  idMap: Map<string, string>,
): Promise<void> {
  for (const notebook of fs.notebooks.list()) {
    const before = JSON.stringify(notebook);
    const planIdMap = new Map(idMap);
    for (const [oldId, newId] of idMap) {
      planIdMap.set(`@${oldId}`, `@${newId}`);
    }
    let rewritten = rewriteDeep(
      structuredClone(notebook),
      planIdMap,
    ) as NotebookDocument;
    rewritten = rewriteInlineMentions(rewritten, idMap);
    if (JSON.stringify(rewritten) !== before) {
      const result = await fs.notebooks.write(rewritten);
      if (!result.ok) {
        throw new Error(
          `Failed to update notebook ${notebook.id}: ${result.error.message}`,
        );
      }
    }
  }
}

function rewriteInlineMentions<T>(value: T, idMap: Map<string, string>): T {
  if (typeof value === "string") {
    return replaceNotebookMentions(
      value,
      [...idMap].map(([reference, replacement]) => ({
        reference,
        replacement: `@${replacement}`,
      })),
    ) as unknown as T;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = rewriteInlineMentions(value[i], idMap);
    }
    return value;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const v = (value as Record<string, unknown>)[key];
      (value as Record<string, unknown>)[key] = rewriteInlineMentions(v, idMap);
    }
  }
  return value;
}

/** Build the display name for an asset id (used by the UI; also exported for
 *  server-side consistency checks). */
export function displayName(assetId: string): string {
  return humanizeSlug(assetId);
}

export type { RenameRow };
