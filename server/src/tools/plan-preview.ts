import type { ClipfirstFs } from "vc-engine";
import { findVideoFile } from "vc-engine";
import { z } from "zod";
import { join } from "node:path";
import { detectSceneCandidates } from "../scene-detect.js";
import { probeVideo } from "../ffmpeg.js";
import { loadAssetForAnalysis } from "./_suggest-shared.js";
import {
  MIN_SCENE_S,
  MAX_SCENE_S,
  REQUIRED_CHARACTERS,
  SYSTEM_PROMPT_PLAN,
  buildPlanContext,
  computeChunks,
  loadCharacter,
  sampleFramesForScenes,
  type CharacterContext,
} from "./plan-visualization.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

type PreviewScene = {
  start: number;
  end: number;
  frames: Array<{ name: string; t: number }>;
};

type PreviewPayload = {
  source_asset_id: string;
  duration_s: number;
  min_scene_s: number;
  max_scene_s: number;
  scenes: PreviewScene[];
  total_frames: number;
  has_word_timings: boolean;
  word_count: number;
  characters: CharacterContext[];
  system_prompt: string;
  user_context: string;
};

export function planPreviewDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "plan_preview",
    description:
      `Dry-run /plan-vis: compute scene boundaries (camera cuts + motion-settle), per-scene sampled frames, ` +
      `and the exact context (system prompt + user message) that would be sent to the vision model — ` +
      `WITHOUT calling the LLM. Read-only. Used by PlanViewer to preview "what's about to be analyzed" ` +
      `before the user clicks Generate Plan. Same args as plan_visualization (exactly ${REQUIRED_CHARACTERS} characters required).`,
    schema: {
      source_asset_id: z.string().describe("Video asset id (vid-*) inside the project"),
      project_slug: z.string().describe("Project slug"),
      character_asset_ids: z
        .array(z.string())
        .length(REQUIRED_CHARACTERS)
        .describe(`Exactly ${REQUIRED_CHARACTERS} subject assets (char-* or img-*)`),
    },
    handler: async (args): Promise<ToolResult> => {
      const { source_asset_id, project_slug, character_asset_ids } = args as {
        source_asset_id: string;
        project_slug: string;
        character_asset_ids: string[];
      };
      const sourceAssetId = source_asset_id.replace(/^@/, "");

      const loaded = await loadAssetForAnalysis(fs, sourceAssetId, project_slug);
      if (!loaded.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: loaded.error.message }],
        };
      }
      const { frameNames, transcript } = loaded.value;

      const manifestResult = await fs.getManifest(sourceAssetId, project_slug, { includeDotfiles: false });
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }
      const videoFile = findVideoFile(manifestResult.value.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${sourceAssetId}` }],
        };
      }
      const videoFsPath = join(manifestResult.value.path, videoFile.name);
      const probe = await probeVideo(videoFsPath);
      const duration = probe.duration;

      const characters: CharacterContext[] = [];
      for (const charId of character_asset_ids) {
        const ctx = await loadCharacter(fs, charId, project_slug);
        if (!ctx) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Character asset not found: ${charId}` }],
          };
        }
        characters.push(ctx);
      }

      let candidates;
      try {
        candidates = await detectSceneCandidates(videoFsPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Scene detection failed: ${msg}` }],
        };
      }

      const chunks = computeChunks(duration, candidates);
      const sampled = sampleFramesForScenes(frameNames, chunks);

      const words = transcript.source === "elevenlabs" ? transcript.words : [];
      const hasWords = transcript.source === "elevenlabs";

      const userContext = buildPlanContext(characters, chunks, words, sampled);

      const scenes: PreviewScene[] = chunks.map((c, idx) => ({
        start: c.start,
        end: c.end,
        frames: sampled
          .filter((f) => f.sceneIdx === idx)
          .map((f) => ({ name: f.name, t: f.t })),
      }));

      const payload: PreviewPayload = {
        source_asset_id: sourceAssetId,
        duration_s: duration,
        min_scene_s: MIN_SCENE_S,
        max_scene_s: MAX_SCENE_S,
        scenes,
        total_frames: sampled.length,
        has_word_timings: hasWords,
        word_count: words.filter((w) => w.type === "word").length,
        characters,
        system_prompt: SYSTEM_PROMPT_PLAN,
        user_context: userContext,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  };
}
