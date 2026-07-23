import type { VideocityFs } from "videobook-engine";
import { findVideoFile } from "videobook-engine";
import { join } from "node:path";
import { z } from "zod";
import { createAudioSyncPlan } from "../audio-sync.js";
import { probeVideo } from "../ffmpeg.js";
import { queue } from "../queue.js";
import type { RequestedAudioSyncAnchor } from "../audio-sync-request.js";
import type { ToolDef } from "./tool-def.js";

function errorResult(message: string): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

const videoAnchor = z.object({
  video_seconds: z.number().nonnegative().describe("Timestamp of the visual action in the source video"),
  audio_seconds: z.number().nonnegative().describe("Timestamp in the original audio where that action should land"),
}).strict();

const cueAnchor = z.object({
  video_seconds: z.number().nonnegative().describe("Timestamp of the visual action in the source video"),
  audio_cue: z.string().trim().min(1).describe("Unique contiguous phrase in the timed ElevenLabs transcript"),
}).strict();

type NumericAudioSyncAnchor = Extract<RequestedAudioSyncAnchor, { audioSeconds: number }>;

function validateVideoAnchors(
  anchors: readonly RequestedAudioSyncAnchor[],
  videoDuration: number,
  sourceFps: number,
): void {
  const frameDuration = 1 / sourceFps;
  let previousVideoSeconds = 0;

  for (const [index, anchor] of anchors.entries()) {
    if (anchor.videoSeconds > videoDuration) {
      throw new Error(`Video anchor ${index + 1} must be within the video duration`);
    }
    if (index > 0 && anchor.videoSeconds <= previousVideoSeconds) {
      throw new Error("Audio-sync video anchors must be strictly increasing");
    }
    if (anchor.videoSeconds - previousVideoSeconds < frameDuration) {
      throw new Error(
        `Audio-sync video anchor intervals must be at least one source frame (${frameDuration.toFixed(6)}s)`,
      );
    }
    previousVideoSeconds = anchor.videoSeconds;
  }

  if (videoDuration - previousVideoSeconds < frameDuration) {
    throw new Error(
      `Audio-sync video anchor intervals must be at least one source frame (${frameDuration.toFixed(6)}s)`,
    );
  }
}

export function syncVideoToAudioDef(fs: VideocityFs): ToolDef {
  return {
    name: "sync_video_to_audio",
    description: "Smoothly retime a video's picture through multiple anchors while preserving its original audio unchanged.",
    schema: {
      asset_id: z.string().describe("Video asset ID"),
      project_slug: z.string().describe("Project slug"),
      anchors: z.array(z.union([cueAnchor, videoAnchor])).min(1).describe("Visual timestamps mapped to transcript cues or numeric audio timestamps"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, anchors } = args as {
        asset_id: string;
        project_slug: string;
        anchors: Array<
          | { video_seconds: number; audio_cue: string }
          | { video_seconds: number; audio_seconds: number }
        >;
      };

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) return errorResult(manifestResult.error.message);
      const videoFile = findVideoFile(manifestResult.value.files);
      if (!videoFile) return errorResult(`No video file found in asset ${asset_id}`);

      const inputPath = join(manifestResult.value.path, videoFile.name);
      let source;
      try {
        source = await probeVideo(inputPath);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
      if (source.videoCodec === null) {
        return errorResult(`No usable video stream found in asset ${asset_id}`);
      }
      if (!source.hasAudio || source.audioDuration === null) {
        return errorResult(`sync_video_to_audio requires an audio stream in asset ${asset_id}`);
      }

      const requestedAnchors: RequestedAudioSyncAnchor[] = anchors.map((anchor) => (
        "audio_cue" in anchor
          ? { videoSeconds: anchor.video_seconds, audioCue: anchor.audio_cue }
          : { videoSeconds: anchor.video_seconds, audioSeconds: anchor.audio_seconds }
      ));
      const numericAnchors = requestedAnchors.filter(
        (anchor): anchor is NumericAudioSyncAnchor => "audioSeconds" in anchor,
      );
      try {
        if (numericAnchors.length === requestedAnchors.length) {
          createAudioSyncPlan({
            videoDuration: source.videoDuration,
            audioDuration: source.audioDuration,
            sourceFps: source.fps,
            anchors: numericAnchors,
          });
        } else {
          validateVideoAnchors(requestedAnchors, source.videoDuration, source.fps);
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
      const now = Date.now();
      const jobId = `sync-audio-${asset_id}-${now}`;
      const outputPath = join(manifestResult.value.path, `.sync-audio-${now}.mp4`);
      await queue.enqueue(jobId, {
        type: "sync_video_to_audio",
        inputPath,
        outputPath,
        anchors: requestedAnchors,
        assetId: asset_id,
        assetDir: manifestResult.value.path,
        projectSlug: project_slug,
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
