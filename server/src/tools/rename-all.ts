/**
 * rename_all MCP tool — bulk rename vid/img assets with an explicit dry
 * run. Dry run uses GPT-5.5 (@apicity/openai) once over each asset's stored
 * context (videos: analysis/transcript text; images: prompt/origin metadata)
 * to propose descriptive names, then revalidates user edits and finally
 * applies via fs.renameAsset + first-class reference updates.
 */
import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { createOpenAi, firstContent } from "@apicity/openai";
import type { OpenAiMessage } from "@apicity/openai";
import {
  isRenamable,
  humanizeSlug,
  buildSuggestionPrompt,
  parseSuggestionResponse,
  buildRenameRows,
  validateEditedRenames,
  applyableRows,
  rewriteTimelineReferences,
  rewriteDeep,
  type RenameRow,
  type AssetContext,
  type EditedRename,
} from "../rename-helpers.js";
import { RENDER_ORIENTATIONS } from "./sync.js";
import type { ToolDef } from "./tool-def.js";

const MODEL = "gpt-5.5";

interface RenamePayload {
  asset_id: string;
  suggested_name: string;
}

const schema = {
  project_slug: z.string().describe("Project slug"),
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
        "Omit on the first dry run to let GPT-5.5 propose names.",
    ),
};

export function renameAllDef(fs: VideocityFs): ToolDef {
  return {
    name: "rename_all",
    description:
      "Bulk-rename vid-*/img-* assets with an explicit dry run. Dry run proposes descriptive names via GPT-5.5 " +
      "over stored analysis/transcript/prompt context; re-run dry_run with edited `renames` to revalidate; " +
      "set dry_run=false to apply via fs.renameAsset and update timeline/OSG/plan references.",
    schema,
    handler: async (args) => {
      const { project_slug, dry_run, renames } = args as {
        project_slug: string;
        dry_run: boolean;
        renames?: RenamePayload[];
      };

      const assets = await fs.listAssets(project_slug);
      const allAssetIds = assets.map((a) => a.id);

      if (dry_run) {
        return renames && renames.length > 0
          ? handleDryRunRevalidation(renames, allAssetIds)
          : handleDryRunSuggest(fs, assets, project_slug, allAssetIds);
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

      return handleApply(fs, project_slug, renames, allAssetIds);
    },
  };
}

async function handleDryRunSuggest(
  fs: VideocityFs,
  assets: { id: string; type: string }[],
  projectSlug: string,
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

  const candidates = assets.filter((a) => isRenamable(a.id));
  const contexts: AssetContext[] = [];
  for (const a of candidates) {
    const ctx = await loadAssetContext(fs, a.id, a.type, projectSlug);
    if (ctx) contexts.push(ctx);
  }

  if (contexts.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          dry_run: true,
          rows: [],
          note: "No vid/img assets with usable context text found.",
        }),
      }],
    };
  }

  const provider = createOpenAi({ apiKey, timeout: 90_000 });
  const messages: OpenAiMessage[] = [
    { role: "user", content: buildSuggestionPrompt(contexts) },
  ];
  const result = await provider.post.v1.chat.completions({
    model: MODEL,
    messages,
    max_completion_tokens: 2048,
  });
  const suggestions = parseSuggestionResponse(firstContent(result));

  const rows = buildRenameRows(contexts, suggestions, allAssetIds);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ dry_run: true, rows, model: MODEL }),
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
  fs: VideocityFs,
  projectSlug: string,
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
    const result = await fs.renameAsset(row.asset_id, row.suggested_name, projectSlug);
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
    idMap.set(row.asset_id, result.value.new_asset_id);
    applied.push({
      asset_id: row.asset_id,
      target_asset_id: row.target_asset_id,
      new_asset_id: result.value.new_asset_id,
      renamed: true,
    });
  }

  if (idMap.size > 0) {
    await updateReferences(fs, projectSlug, idMap);
  }

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ dry_run: false, applied, references_updated: idMap.size > 0 }),
    }],
  };
}

/** Load the stored context text used to drive GPT's name suggestion.
 *  Videos: analysis summary + transcript text. Images: prompt + origin meta.
 *  Returns null when no useful text is available (skip the asset). */
async function loadAssetContext(
  fs: VideocityFs,
  assetId: string,
  type: string,
  projectSlug: string,
): Promise<AssetContext | null> {
  if (type === "video" || assetId.startsWith("vid-")) {
    return loadVideoContext(fs, assetId, projectSlug);
  }
  if (type === "image" || assetId.startsWith("img-")) {
    return loadImageContext(fs, assetId, projectSlug);
  }
  return null;
}

async function loadVideoContext(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
): Promise<AssetContext | null> {
  const parts: string[] = [];

  const analysisRead = await fs.readFile(assetId, ".original.analysis.json", projectSlug);
  if (analysisRead.ok) {
    try {
      const analysis = JSON.parse(
        typeof analysisRead.value === "string"
          ? analysisRead.value
          : new TextDecoder().decode(analysisRead.value),
      ) as Record<string, unknown>;
      const summary = typeof analysis.summary === "string" ? analysis.summary : "";
      const subjects = Array.isArray(analysis.subjects) ? analysis.subjects.join(", ") : "";
      const setting = typeof analysis.setting === "string" ? analysis.setting : "";
      const tags = Array.isArray(analysis.tags) ? analysis.tags.join(", ") : "";
      if (summary) parts.push(summary);
      if (subjects) parts.push(`subjects: ${subjects}`);
      if (setting) parts.push(`setting: ${setting}`);
      if (tags) parts.push(`tags: ${tags}`);
    } catch {
      // ignore parse errors
    }
  }

  for (const transFile of [".analysis.gpt4otrans.json", "elevenlabs.json"]) {
    const transRead = await fs.readFile(assetId, transFile, projectSlug);
    if (!transRead.ok) continue;
    try {
      const parsed = JSON.parse(
        typeof transRead.value === "string"
          ? transRead.value
          : new TextDecoder().decode(transRead.value),
      ) as { text?: string };
      if (parsed.text && parsed.text.trim()) {
        parts.push(`transcript: ${parsed.text.trim()}`);
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
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
): Promise<AssetContext | null> {
  const parts: string[] = [];
  const meta = await fs.readMetadata<Record<string, unknown>>(assetId, "original", projectSlug);
  if (meta.ok) {
    const prompt = typeof meta.value.prompt === "string" ? meta.value.prompt : "";
    const origin = typeof meta.value.origin === "string" ? meta.value.origin : "";
    if (prompt) parts.push(prompt);
    if (origin) parts.push(`origin: ${origin}`);
  }
  if (parts.length === 0) return null;
  return { asset_id: assetId, type: "image", context_text: parts.join("\n") };
}

/** Rewrite first-class references after a batch rename: timeline slots/audio,
 *  per-asset OSG render metadata (osgAssetId), and plan/.plan.json ids. */
async function updateReferences(
  fs: VideocityFs,
  projectSlug: string,
  idMap: Map<string, string>,
): Promise<void> {
  await updateTimelineReferences(fs, projectSlug, idMap);
  await updateOsgReferences(fs, projectSlug, idMap);
  await updatePlanReferences(fs, projectSlug, idMap);
}

async function updateTimelineReferences(
  fs: VideocityFs,
  projectSlug: string,
  idMap: Map<string, string>,
): Promise<void> {
  const read = await fs.readProjectMeta<unknown>("timeline", projectSlug);
  if (!read.ok) return;
  const config = read.value as {
    slots?: Array<{ slug?: string }>;
    audio?: Array<{ slug?: string }>;
  };
  const before = JSON.stringify(config);
  rewriteTimelineReferences(config, idMap);
  if (JSON.stringify(config) !== before) {
    await fs.writeProjectMeta("timeline", config, projectSlug);
  }
}

async function updateOsgReferences(
  fs: VideocityFs,
  projectSlug: string,
  idMap: Map<string, string>,
): Promise<void> {
  const assets = await fs.listAssets(projectSlug);
  for (const asset of assets) {
    if (!asset.id.startsWith("vid-")) continue;
    let changed = false;
    for (const orient of RENDER_ORIENTATIONS) {
      const metaKey = `${orient}.render`;
      const read = await fs.readMetadata<Record<string, unknown>>(
        asset.id,
        metaKey,
        projectSlug,
      );
      if (!read.ok) continue;
      const osgId = read.value.osgAssetId;
      if (typeof osgId === "string" && idMap.has(osgId)) {
        read.value.osgAssetId = idMap.get(osgId);
        changed = true;
        await fs.writeMetadata(asset.id, metaKey, read.value, projectSlug);
      }
    }
    void changed;
  }
}

async function updatePlanReferences(
  fs: VideocityFs,
  projectSlug: string,
  idMap: Map<string, string>,
): Promise<void> {
  const planRead = await fs.readFile("plan", ".plan.json", projectSlug);
  if (!planRead.ok) return;
  let plan: unknown;
  try {
    plan = JSON.parse(
      typeof planRead.value === "string"
        ? planRead.value
        : new TextDecoder().decode(planRead.value),
    );
  } catch {
    return;
  }
  const before = JSON.stringify(plan);
  plan = rewriteDeep(plan, idMap);
  if (JSON.stringify(plan) !== before) {
    await fs.writeFile("plan", ".plan.json", JSON.stringify(plan, null, 2), projectSlug);
  }
}

/** Build the display name for an asset id (used by the UI; also exported for
 *  server-side consistency checks). */
export function displayName(assetId: string): string {
  return humanizeSlug(assetId);
}

export type { RenameRow };
