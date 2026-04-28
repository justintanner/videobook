import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { Orientation } from "../remotion/subtitles/types.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { queue } from "../queue.js";
import { findAutoRenderActions, readStoredRenderDefaults } from "./sync.js";

type TimelineSlot = {
  slug: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
};

type TimelineAudioClip = {
  id: string;
  slug: string;
  startFrame: number;
  durationFrames: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
};

type ViewerSize = 'landscape' | 'portrait' | 'square' | 'original';

type TimelineConfig = {
  slots: TimelineSlot[];
  audio?: TimelineAudioClip[];
  render: Orientation;
  currentOrientation?: ViewerSize;
};

function toolError(msg: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
}

function normalizeConfig(raw: TimelineConfig | TimelineSlot[]): TimelineConfig {
  if (Array.isArray(raw)) return { slots: raw, render: "landscape" };
  return {
    ...raw,
    render: Array.isArray(raw.render)
      ? ((raw.render as unknown as string[])[0] ?? "landscape") as Orientation
      : raw.render,
  };
}

export function assignSlotDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "assign_slot",
    description: "Assign an asset to a timeline slot (e.g. slot 's02' = index 1)",
    schema: {
      project_slug: z.string().describe("Project slug"),
      asset_id: z.string().describe("Asset ID to assign to the slot"),
      slot: z.string().describe("Slot identifier like 's02' (@ prefix already stripped)"),
    },
    handler: async (args) => {
      const { project_slug, asset_id, slot } = args as {
        project_slug: string;
        asset_id: string;
        slot: string;
      };

      // Parse slot index from e.g. "s02" → 1
      const match = slot.match(/^s(\d+)$/);
      if (!match) {
        return toolError(`Invalid slot format: "${slot}". Expected format like "s01", "s02", etc.`);
      }
      const index = parseInt(match[1], 10) - 1;
      if (index < 0) {
        return toolError(`Slot index must be >= 1, got "${slot}"`);
      }

      // Validate asset exists
      const assets = await fs.listAssets(project_slug);
      const asset = assets.find((a) => a.id === asset_id);
      if (!asset) {
        return toolError(`Asset "${asset_id}" not found in project "${project_slug}"`);
      }

      // Read current timeline (default to empty)
      const readResult = await fs.readProjectMeta<TimelineConfig | TimelineSlot[]>("timeline", project_slug);
      let config: TimelineConfig;
      if (readResult.ok) {
        config = normalizeConfig(readResult.value);
      } else {
        const err = (readResult as { ok: false; error: { code: string; message: string } }).error;
        if (err.code === "NOT_FOUND") {
          config = { slots: [], render: "landscape" };
        } else {
          return toolError(err.message);
        }
      }

      // Pad slots array if needed
      while (config.slots.length <= index) {
        config.slots.push({ slug: "" });
      }

      // Assign asset to slot (preserve existing volume/fade)
      config.slots[index] = { ...config.slots[index], slug: asset_id };

      // Write back
      const writeResult = await fs.writeProjectMeta("timeline", config, project_slug);
      if (writeResult.ok) {
        // Auto-render eligible videos after assignment
        let autoRenderJobId: string | undefined;
        if (asset_id.startsWith("vid-")) {
          try {
            const orientation = Array.isArray(config.render)
              ? (config.render[0] ?? "landscape")
              : config.render;
            const renderActions = await findAutoRenderActions(fs, project_slug, [asset], orientation);
            if (renderActions.length > 0) {
              const action = renderActions[0];
              const stored = await readStoredRenderDefaults(fs, asset_id, project_slug, orientation);
              const jobId = `auto-render-${asset_id}-${Date.now()}`;
              await queue.enqueue(jobId, {
                type: "render_project",
                projectSlug: project_slug,
                orientation,
                assets: [{
                  assetId: action.assetId,
                  assetDir: action.assetDir,
                  videoPath: action.videoPath,
                  videoFilename: action.videoFilename,
                  hasElevenlabs: action.hasElevenlabs,
                }],
                subtitlesEnabled: action.hasElevenlabs ? (stored.subtitlesEnabled as boolean) : false,
                highlightStyle: stored.highlightStyle as string,
                position: stored.position as string,
                fontSize: stored.fontSize as string,
                textColor: stored.textColor as string,
                highlightColor: stored.highlightColor as string,
                audioFadeIn: stored.audioFadeIn as number,
                audioFadeOut: stored.audioFadeOut as number,
                audioVolume: stored.audioVolume as number,
                osgImagePath: (stored.osgImagePath as string | null) ?? null,
                osgPosition: stored.osgPosition as string,
                backgroundMode: stored.backgroundMode as string,
              });
              autoRenderJobId = jobId;
            }
          } catch {
            // Auto-render failure must not fail the assignment
          }
        }

        const response: Record<string, unknown> = { ...config };
        if (autoRenderJobId) {
          response.auto_render = { jobId: autoRenderJobId };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response) }],
        };
      }
      const writeErr = (writeResult as { ok: false; error: { message: string } }).error;
      return toolError(writeErr.message);
    },
  };
}
