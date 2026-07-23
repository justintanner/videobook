import type { VideocityFs } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile, findAudioFile } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";

export function replaceVideoAudioDef(fs: VideocityFs): ToolDef {
  return {
    name: "replace_video_audio",
    description: "Replace the audio track of a video asset in-place with audio from an aud-* asset, or a specific file inside another asset via the `<assetId>/<filename>` form (e.g. `plan/s1.mp3`). Operates on the vid- asset's original.mp4 with git versioning. Existing per-orientation renders are now stale — re-run /render before /final.",
    schema: {
      asset_id: z.string().describe("Video asset whose audio is being replaced (vid-*)"),
      audio_asset_id: z.string().describe("Audio source: an aud-* asset id, or `<assetId>/<filename>` to point at a specific file inside another asset (e.g. `plan/s1.mp3`)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, audio_asset_id, project_slug } = args as {
        asset_id: string;
        audio_asset_id: string;
        project_slug: string;
      };

      if (!asset_id.startsWith("vid-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `asset_id must be a vid-* asset, got: ${asset_id}` }],
        };
      }

      // `<assetId>/<filename>` addresses a specific sibling file. Used by
      // PlanViewer to splice the per-scene `plan/sN.mp3` into a freshly-
      // generated seedance vid-* output. Bare ids must remain aud-* prefixed.
      const slashIdx = audio_asset_id.indexOf("/");
      const audioAssetIdResolved = slashIdx >= 0 ? audio_asset_id.slice(0, slashIdx) : audio_asset_id;
      const audioFilenameOverride = slashIdx >= 0 ? audio_asset_id.slice(slashIdx + 1) : null;
      if (slashIdx < 0 && !audio_asset_id.startsWith("aud-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `audio_asset_id must be an aud-* asset or <assetId>/<filename>, got: ${audio_asset_id}` }],
        };
      }

      const videoManifest = await fs.getManifest(asset_id, project_slug);
      if (!videoManifest.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: videoManifest.error.message }],
        };
      }
      const videoFile = findVideoFile(videoManifest.value.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${asset_id}` }],
        };
      }

      const audioManifest = await fs.getManifest(audioAssetIdResolved, project_slug, { includeDotfiles: true });
      if (!audioManifest.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: audioManifest.error.message }],
        };
      }
      let audioFileName: string;
      if (audioFilenameOverride !== null) {
        const file = audioManifest.value.files.find((f) => f.name === audioFilenameOverride);
        if (!file) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `File ${audioFilenameOverride} not found in asset ${audioAssetIdResolved}` }],
          };
        }
        audioFileName = file.name;
      } else {
        const file = findAudioFile(audioManifest.value.files, audioAssetIdResolved);
        if (!file) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `No audio file found in asset ${audioAssetIdResolved}` }],
          };
        }
        audioFileName = file.name;
      }

      const assetDir = videoManifest.value.path;
      const videoPath = join(assetDir, videoFile.name);
      const audioPath = join(audioManifest.value.path, audioFileName);
      const tempPath = join(assetDir, "original_audio_replaced.mp4");
      const jobId = `replace-audio-${asset_id}-${Date.now()}`;

      try {
        await queue.enqueueAndWait(jobId, {
          type: "replace_video_audio",
          inputPath: videoPath,
          audioPath,
          outputPath: tempPath,
          assetId: asset_id,
          assetDir,
          audioAssetId: audio_asset_id,
          projectSlug: project_slug,
        } as unknown as Record<string, unknown>);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Replace audio failed: ${msg}` }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id, audio_asset_id, job_id: jobId, status: "completed" }),
        }],
      };
    },
  };
}

