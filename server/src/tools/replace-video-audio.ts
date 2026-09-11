import type { Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile, findAudioFile } from "videobook-engine";
import { probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";

export function replaceVideoAudioDef(engine: Engine): ToolDef {
  return {
    name: "replace_video_audio",
    description: "Replace the audio track of a video asset in-place with audio from an audio asset, or a specific file inside another asset via the `<artifactId>/<filename>` form. Operates on the video asset's original.mp4 with git versioning. Existing per-orientation renders are now stale — re-run /render before /final.",
    schema: {
      asset_id: z.string().describe("Video artifact whose audio is being replaced"),
      audio_asset_id: z.string().describe("Audio source: an audio artifact id, or `<artifactId>/<filename>` to point at a specific file inside another artifact"),
      book_id: z.string().describe("Book UUID"),
    },
    handler: async (args) => {
      const { asset_id, audio_asset_id, book_id } = args as {
        asset_id: string;
        audio_asset_id: string;
        book_id: string;
      };

      const videoArtifact = engine.artifacts.get(asset_id);
      if (!videoArtifact.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: videoArtifact.error.message }],
        };
      }
      if (videoArtifact.value.kind !== "video") {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `asset_id must be a video artifact, got ${videoArtifact.value.kind} artifact ${asset_id}` }],
        };
      }

      // `<artifactId>/<filename>` addresses a specific sibling file. Used by
      // PlanViewer to splice the per-scene `plan/sN.mp3` into a freshly-
      // generated seedance video output. Bare ids must be audio artifacts.
      const slashIdx = audio_asset_id.indexOf("/");
      const audioAssetIdResolved = slashIdx >= 0 ? audio_asset_id.slice(0, slashIdx) : audio_asset_id;
      const audioFilenameOverride = slashIdx >= 0 ? audio_asset_id.slice(slashIdx + 1) : null;
      const audioArtifact = engine.artifacts.get(audioAssetIdResolved);
      if (!audioArtifact.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: audioArtifact.error.message }],
        };
      }
      if (slashIdx < 0 && audioArtifact.value.kind !== "audio") {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `audio_asset_id must be an audio artifact or <artifactId>/<filename>, got ${audioArtifact.value.kind} artifact ${audio_asset_id}` }],
        };
      }

      const videoManifest = await engine.files.manifest(asset_id);
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

      const audioManifest = await engine.files.manifest(audioAssetIdResolved);
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
        const file = findAudioFile(audioManifest.value.files, audioArtifact.value.kind);
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
      try {
        const [video, audio] = await Promise.all([probeVideo(videoPath), probeVideo(audioPath)]);
        if (!video.videoStream || video.videoDuration <= 0) throw new Error("Video source has no playable video stream");
        if (!audio.hasAudio || (audio.audioDuration ?? audio.duration) <= 0) throw new Error("Replacement source has no playable audio stream");
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
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
          bookId: book_id,
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
