import type { VideocityFs } from "videocity-engine";
import { actionNameForTool, isLoggedToolActivity } from "./activity-policy.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { isImageGenerationTool } from "../image-models.js";
import { isVideoGenerationTool } from "../video-models.js";
import { emptyNotebookDefinition, writeNotebookFiles } from "../notebook-store.js";
import { canonicalCharacterId } from "../google-flow-refs.js";

type CaptureCategory = "generate" | "edit" | "extend" | "upscale" | "batch" | "retry";

function getAuditCategory(toolName: string): CaptureCategory | null {
  if (toolName === "retry_generation") return "retry";
  if (toolName === "gen_images_all_models") return "batch";
  
  if (isImageGenerationTool(toolName) || isVideoGenerationTool(toolName)) {
    if (toolName.includes("edit")) return "edit";
    if (toolName.includes("extend")) return "extend";
    if (toolName.includes("upscale")) return "upscale";
    return "generate";
  }
  return null;
}

function normalizeAssetId(id: string): string {
  if (!id) return id;
  const normalized = id.startsWith("@") ? id.slice(1) : id;
  return canonicalCharacterId(normalized);
}

function normalizeInputs(args: Record<string, unknown>): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "project_slug") continue;
    if (typeof v === "string") {
      inputs[k] = normalizeAssetId(v);
    } else if (Array.isArray(v)) {
      inputs[k] = v.map(item => typeof item === "string" ? normalizeAssetId(item) : item);
    } else {
      inputs[k] = v;
    }
  }
  return inputs;
}

function extractOutcome(result: ToolResult): { assetIds?: string[]; error?: string } | undefined {
  if (result.isError) {
    return { error: result.content[0]?.text ?? "unknown error" };
  }
  
  const text = result.content[0]?.text;
  if (!text) return undefined;
  
  try {
    const parsed = JSON.parse(text);
    const assetIds: string[] = [];
    
    if (typeof parsed.img_asset_id === "string") assetIds.push(parsed.img_asset_id);
    if (typeof parsed.vid_asset_id === "string") assetIds.push(parsed.vid_asset_id);
    if (typeof parsed.asset_id === "string" && parsed.retried) assetIds.push(parsed.asset_id);
    
    if (Array.isArray(parsed.results)) {
      for (const r of parsed.results) {
        if (typeof r.img_asset_id === "string") assetIds.push(r.img_asset_id);
        if (typeof r.vid_asset_id === "string") assetIds.push(r.vid_asset_id);
      }
    }
    
    return { assetIds: assetIds.length > 0 ? assetIds : [] };
  } catch {
    return undefined;
  }
}

async function resolveProjectCaptureTarget(fs: VideocityFs, projectSlug: string): Promise<string> {
  const meta = await fs.readProjectMeta<{ notebook_id?: string }>("last-active-notebook", projectSlug);
  let notebookId = meta.ok && meta.value?.notebook_id ? meta.value.notebook_id : undefined;
  
  if (notebookId) {
    const asset = await fs.resolveAssetDir(notebookId, projectSlug);
    if (!asset.ok) notebookId = undefined;
  }

  if (!notebookId) {
    const scratchAsset = await fs.createAsset("nb", "scratch", projectSlug);
    if (scratchAsset.ok) {
      notebookId = scratchAsset.value.assetId;
      await writeNotebookFiles(fs, projectSlug, notebookId, emptyNotebookDefinition());
      await fs.writeProjectMeta("last-active-notebook", { notebook_id: notebookId }, projectSlug);
    }
  }
  
  return notebookId ?? "nb-fallback";
}

function withLogging(def: ToolDef, fs: VideocityFs): ToolDef {
  return {
    ...def,
    handler: async (args) => {
      const slug = args.project_slug as string | undefined;
      const category = getAuditCategory(def.name);
      
      let notebookId: string | undefined;
      if (slug && category) {
        notebookId = await resolveProjectCaptureTarget(fs, slug);
      }

      const start = performance.now();
      const result = await def.handler(args);
      const ms = Math.round(performance.now() - start);

      const status = result.isError ? "error" : "ok";
      const suffix = result.isError
        ? ` ${result.content[0]?.text.slice(0, 80)}`
        : "";
      console.log(`[mcp] ${def.name} ${status} ${ms}ms${suffix}`);

      if (slug && isLoggedToolActivity(def.name, args, result)) {
        const actionName = actionNameForTool(def.name);
        const logPayload: Record<string, unknown> = result.isError
          ? { ...args, _error: result.content[0]?.text ?? "unknown error" }
          : { ...args };

        if (category && notebookId) {
          logPayload._notebook_capture = {
            notebook_id: notebookId,
            category,
            inputs: normalizeInputs(args),
            outcome: extractOutcome(result),
            version: 1,
          };
        }

        try {
          await fs.logAction(actionName, logPayload, slug);
        } catch (e) {
          console.warn(`[mcp] action log failed for ${actionName}:`, e);
        }
      }

      return result;
    },
  };
}

export { withLogging };
