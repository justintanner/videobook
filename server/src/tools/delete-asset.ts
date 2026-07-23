import type { VideocityFs } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

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

type TimelineConfig = {
  slots: TimelineSlot[];
  audio?: TimelineAudioClip[];
  render: "landscape" | "portrait" | "square";
  currentOrientation?: "landscape" | "portrait" | "square" | "original";
};

function normalizeConfig(raw: TimelineConfig | TimelineSlot[]): TimelineConfig {
  if (Array.isArray(raw)) return { slots: raw, render: "landscape" };
  return raw;
}

async function removeFromTimeline(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
): Promise<{ updated: boolean; error?: string }> {
  const readResult = await fs.readProjectMeta<TimelineConfig | TimelineSlot[]>("timeline", projectSlug);
  if (!readResult.ok) {
    const error = (readResult as { ok: false; error: { code: string; message: string } }).error;
    if (error.code === "NOT_FOUND") return { updated: false };
    return { updated: false, error: error.message };
  }

  const config = normalizeConfig(readResult.value);
  let updated = false;
  const slots = config.slots.map((slot) => {
    if (slot.slug !== assetId) return slot;
    updated = true;
    return { slug: "" };
  });
  const audio = (config.audio ?? []).filter((clip) => {
    const keep = clip.slug !== assetId;
    if (!keep) updated = true;
    return keep;
  });

  if (!updated) return { updated: false };

  const nextConfig: TimelineConfig = {
    ...config,
    slots,
    ...(audio.length > 0 ? { audio } : {}),
  };
  if ((config.audio ?? []).length > 0 && audio.length === 0) {
    nextConfig.audio = [];
  }
  const writeResult = await fs.writeProjectMeta("timeline", nextConfig, projectSlug);
  if (!writeResult.ok) {
    const error = (writeResult as { ok: false; error: { message: string } }).error;
    return { updated: false, error: error.message };
  }
  return { updated: true };
}

export function deleteAssetDef(fs: VideocityFs): ToolDef {
  return {
    name: "delete_asset",
    description: "Delete an asset directory",
    schema: {
      asset_id: z.string().describe("Asset ID to delete (e.g. img-cute-cat)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
      const result = await fs.deleteAsset(asset_id, project_slug);
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "deleted",
            asset_id,
            deleted_at: result.value.deleted_at,
            timeline: await removeFromTimeline(fs, asset_id, project_slug),
          }),
        }],
      };
    },
  };
}
