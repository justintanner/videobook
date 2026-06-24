import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { queue } from "../queue.js";
import type { Candidate } from "../scene-detect.js";
import type { ToolDef } from "./tool-def.js";
import {
  decodeBuffer,
  loadAssetForAnalysis,
  MODEL,
  type ElevenLabsWord,
} from "./_suggest-shared.js";

// Scene length window. Floor stays at 7s (matches the prior fixed-chunk
// default and the per-modality reference budget headroom on seedance-2);
// ceiling 14s leaves 1s of safety under the kie/seedance ≤15s reference cap.
// Cuts prefer the strongest visual break (camera cut > motion settle) inside
// [cursor+MIN, cursor+MAX]; hard-cut at +MAX when no break qualifies.
export const MIN_SCENE_S = 7;
export const MAX_SCENE_S = 14;
export const REQUIRED_CHARACTERS = 2;

export type CharacterContext = {
  asset_id: string;
  name: string;
  description: string;
};

export type Chunk = {
  start: number;
  end: number;
};

export const SYSTEM_PROMPT_PLAN = `You produce one cinematic prompt per pre-computed video chunk. Each prompt drives a two-stage pipeline: (1) image-to-image at 2K using the source video's aspect ratio swaps the two on-screen subjects in the chunk's first and last frames with the two reference characters; (2) bytedance/seedance-2 then animates between those two edited frames using the chunk video as a motion reference and the chunk audio as a dialogue/timing reference.

INPUTS YOU RECEIVE:
- Two characters (exactly two, by @asset_id) — these REPLACE the two main on-screen subjects in every chunk.
- A pre-computed list of chunks. Each chunk is ${MIN_SCENE_S}–${MAX_SCENE_S}s wide (variable, aligned to silence gaps in the transcript where possible) with explicit start/end and the transcript words spoken inside it.
- Sampled frames from the source clip (image inputs). Each frame is labelled with its timestamp in the user message; map frames to chunks by timestamp to ground your descriptions in what actually appears on screen.

YOUR JOB:
For each chunk, return one "visual" — a single dense paragraph (60–110 words) that:

1. Names the two characters by their @asset_id token verbatim. Never use the human-readable name. Downstream tools resolve @asset_id to the actual likeness.
2. Describes the cinematic SHOT — environment, lighting, color palette, mood, camera (lens, angle, motion), composition. Default to photorealistic, 8k, shallow depth of field. Anchor to what the sampled frames actually show in this chunk's time window.
3. Describes the ACTION the two characters perform across the chunk — phrased so it reads as motion between a "first beat" (frame 0 of the chunk) and a "final beat" (last frame of the chunk). Seedance interpolates between two edited reference frames; your prompt must imply that motion arc explicitly.
4. Locks character identity: include "lock the appearance of @<charA-id> and @<charB-id> to reference image 1 and reference image 2 respectively". The frames go in reference_image_urls (NOT first_frame_url / last_frame_url — those are mutually exclusive with the multimodal reference fields and would be rejected by the Seedance 2 schema).
5. Honors the chunk's audio: dialogue, pacing, and audible action cues from the transcript drive what the characters DO. Match on-screen action to the words spoken in this chunk.
6. Concrete > abstract. If the chunk's words are metaphorical, render the metaphor literally and visually.

OUTPUT: JSON only, matching the provided schema. The "visuals" array MUST have exactly one entry per chunk, in the same order as the input chunks.`;

// Minimal sidecar persisted the moment a char_swap plan is requested, so the
// /plan work area can render the source video, the two characters, and the
// analysis prompt (with a loader) right away — before the background job has
// produced any scenes. The job overwrites .plan.json with the full plan (scenes,
// user_context, word_count, real duration) on completion. Shape mirrors the
// job's sidecar so the client reads the two identically.
export function buildSkeletonPlanSidecar(sourceAssetId: string, characters: CharacterContext[]) {
  return {
    formula: "char_swap" as const,
    scenes: [] as Array<{ start: number; end: number; visual: string }>,
    source_asset_id: sourceAssetId,
    total_duration_s: 0,
    max_scene_seconds: MAX_SCENE_S,
    characters,
    model: MODEL,
    analysis_prompt: SYSTEM_PROMPT_PLAN,
  };
}

export async function loadCharacter(
  fs: VideocityFs,
  charId: string,
  projectSlug: string,
): Promise<CharacterContext | null> {
  const cleanId = charId.replace(/^@/, "");
  const manifestResult = await fs.getManifest(cleanId, projectSlug, { includeDotfiles: true });
  if (!manifestResult.ok) return null;

  const files = manifestResult.value.files;
  let name = cleanId.replace(/^(char-|img-)/, "");
  let description = "";

  const charJsonFile = files.find((f) => f.name === ".character.json");
  if (charJsonFile) {
    const readResult = await fs.readFile(cleanId, ".character.json", projectSlug);
    if (readResult.ok) {
      try {
        const parsed = JSON.parse(decodeBuffer(readResult.value)) as Record<string, unknown>;
        if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
          name = parsed.name;
        }
        const descParts: string[] = [];
        if (typeof parsed.subject_kind === "string") descParts.push(`kind=${parsed.subject_kind}`);
        if (typeof parsed.other === "string" && parsed.other.trim().length > 0) descParts.push(parsed.other);
        description = descParts.join("; ");
      } catch {
        // fall through to fallback
      }
    }
  }

  if (description.length === 0) {
    const mdName = files.find((f) => f.name === "index.md" || f.name === "original.md")?.name;
    if (mdName) {
      const readResult = await fs.readFile(cleanId, mdName, projectSlug);
      if (readResult.ok) {
        const text = decodeBuffer(readResult.value).trim().slice(0, 400);
        description = text.replace(/\s+/g, " ");
      }
    }
  }

  return { asset_id: cleanId, name, description };
}

// Cut snap: every internal scene boundary lands on a whole-second marker —
// required for even-split's trimRangeExact and seedance-2's integer duration
// field. Snap picks the integer ≥ windowStart and ≤ windowEnd nearest to the
// raw cut. If no integer fits the window (only possible when MIN/MAX get
// tight at the tail), fall through and ffmpeg snaps to the nearest keyframe.
function snapCutToSecond(raw: number, lo: number, hi: number): number {
  const ceilLo = Math.ceil(lo);
  const floorHi = Math.floor(hi);
  if (ceilLo > floorHi) return raw;
  const rounded = Math.round(raw);
  if (rounded >= ceilLo && rounded <= floorHi) return rounded;
  return rounded < ceilLo ? ceilLo : floorHi;
}

// Walk forward, picking each cut at the strongest candidate inside the legal
// window [cursor+MIN, cursor+MAX]. Camera cuts (kind="shot") rank ahead of
// motion-settle candidates regardless of score; within a kind, higher score
// wins; ties broken by later position (longer first chunk → fewer scenes →
// cheaper downstream gen). When no candidate qualifies, hard-cut at +MAX so
// we never emit a scene > MAX.
//
// On the final cut (remaining ≤ 2*MAX), the window is constrained on both
// ends to guarantee the trailing chunk also lands in [MIN, MAX]:
//   windowStart = max(cursor+MIN, duration-MAX)
//   windowEnd   = min(cursor+MAX, duration-MIN)
//
// Cuts snap to integer seconds via snapCutToSecond.
function rankBetter(a: Candidate, b: Candidate): boolean {
  if (a.kind !== b.kind) return a.kind === "shot";
  if (a.score !== b.score) return a.score > b.score;
  return a.t > b.t;
}

export function computeChunks(duration: number, candidates: Candidate[]): Chunk[] {
  if (duration <= 0) return [];
  if (duration <= MAX_SCENE_S) return [{ start: 0, end: duration }];

  const chunks: Chunk[] = [];
  let cursor = 0;

  while (duration - cursor > MAX_SCENE_S) {
    const remaining = duration - cursor;
    let windowStart = cursor + MIN_SCENE_S;
    let windowEnd = cursor + MAX_SCENE_S;
    if (remaining <= 2 * MAX_SCENE_S) {
      windowStart = Math.max(windowStart, duration - MAX_SCENE_S);
      windowEnd = Math.min(windowEnd, duration - MIN_SCENE_S);
    }

    let best: Candidate | null = null;
    for (const c of candidates) {
      if (c.t < windowStart || c.t > windowEnd) continue;
      if (best === null || rankBetter(c, best)) best = c;
    }

    const cut = snapCutToSecond(best ? best.t : windowEnd, windowStart, windowEnd);
    chunks.push({ start: cursor, end: cut });
    cursor = cut;
  }

  chunks.push({ start: cursor, end: duration });
  return chunks;
}

// Per-scene frame sampling. Pulls roughly ceil((end-start)/2) frames from the
// pre-extracted original_frames/ directory whose timestamps fall in [start, end),
// clamped to [SCENE_FRAMES_MIN, SCENE_FRAMES_MAX]. A 14s scene gets ~7 frames; a
// 7s scene gets ~4. The vision model receives them in chunk order with a
// per-chunk timestamp manifest so it can ground each frame to its scene.
const SCENE_FRAMES_MIN = 3;
const SCENE_FRAMES_MAX = 8;

export function sampleFramesForScenes(
  frameNames: string[],
  scenes: Chunk[],
): Array<{ name: string; sceneIdx: number; t: number }> {
  const parsed = frameNames
    .map((name) => ({ name, t: parseFloat(name) }))
    .filter((f) => Number.isFinite(f.t))
    .sort((a, b) => a.t - b.t);
  const out: Array<{ name: string; sceneIdx: number; t: number }> = [];

  scenes.forEach((scene, sceneIdx) => {
    const inScene = parsed.filter((f) => f.t >= scene.start && f.t < scene.end);
    if (inScene.length === 0) return;
    const target = Math.min(
      SCENE_FRAMES_MAX,
      Math.max(SCENE_FRAMES_MIN, Math.ceil((scene.end - scene.start) / 2)),
    );
    if (inScene.length <= target) {
      for (const f of inScene) out.push({ name: f.name, sceneIdx, t: f.t });
      return;
    }
    const step = (inScene.length - 1) / (target - 1);
    for (let i = 0; i < target; i++) {
      const f = inScene[Math.round(i * step)];
      out.push({ name: f.name, sceneIdx, t: f.t });
    }
  });

  return out;
}

// Per-chunk spoken dialog, sliced from the word-level transcript by the chunk's
// [start, end) window. Single source of truth for both the vision-model context
// blob and the per-scene `dialog` field persisted in the plan sidecar.
export function dialogForChunk(words: ElevenLabsWord[], chunk: Chunk): string {
  const wordsOnly = words.filter((w) => w.type === "word");
  const inChunk = wordsOnly.filter((w) => w.start >= chunk.start && w.start < chunk.end);
  return inChunk.map((w) => w.text).join(" ").trim() || "(no speech in this chunk)";
}

export function buildPlanContext(
  characters: CharacterContext[],
  chunks: Chunk[],
  words: ElevenLabsWord[],
  sampledFrames: Array<{ name: string; sceneIdx: number; t: number }>,
): string {
  const charBlock = characters
    .map((c, i) => `  ${i + 1}. @${c.asset_id} (also known as: ${c.name}) — ${c.description || "(no description)"}`)
    .join("\n");

  const chunkBlocks = chunks.map((c, i) => {
    const text = dialogForChunk(words, c);
    const chunkFrameTs = sampledFrames
      .filter((f) => f.sceneIdx === i)
      .map((f) => `${f.t.toFixed(2)}s`)
      .join(", ");
    return [
      `Chunk ${i + 1}: ${c.start.toFixed(2)}s – ${c.end.toFixed(2)}s (${(c.end - c.start).toFixed(2)}s)`,
      `Transcript: ${text}`,
      `Frame timestamps for this chunk: ${chunkFrameTs || "(none)"}`,
    ].join("\n");
  });

  const allTimestamps = sampledFrames
    .map((f) => `s${f.sceneIdx + 1}@${f.t.toFixed(2)}s`)
    .join(", ");

  return [
    `Characters (use the @asset_id token verbatim in every visual):`,
    charBlock,
    "",
    `Chunks (${chunks.length} total — produce one "visual" per chunk, in order):`,
    "",
    chunkBlocks.join("\n\n"),
    "",
    `Image inputs follow in this order (chunk-tagged): ${allTimestamps}`,
  ].join("\n");
}

export function planVisualizationDef(fs: VideocityFs): ToolDef {
  return {
    name: "plan_visualization",
    description:
      `Generate a per-chunk gpt-image-2 + Seedance 2 remix plan from a video asset. ` +
      `Splits the clip into ${MIN_SCENE_S}–${MAX_SCENE_S}s chunks aligned to natural visual breaks — camera cuts and motion-settle points (hard-cuts at ${MAX_SCENE_S}s when no break is available), samples per-scene frames + transcript context, ` +
      `then asks an LLM to produce one cinematic Seedance 2 prompt per chunk that locks the two named characters to the chunk's first/last frame edits. Runs in the background. ` +
      `Requires exactly ${REQUIRED_CHARACTERS} subject assets (char-* or img-*) and a transcribed video source (elevenlabs.json with word timings — run /transcribe first if missing). ` +
      `Writes plan/index.md (human-readable) and plan/.plan.json (structured, includes analysis_prompt), overwriting prior.`,
    schema: {
      source_asset_id: z.string().describe("Video asset with elevenlabs.json (vid-* — word-level timings required)"),
      project_slug: z.string().describe("Project slug"),
      character_asset_ids: z
        .array(z.string())
        .length(REQUIRED_CHARACTERS)
        .describe(`Exactly ${REQUIRED_CHARACTERS} subject assets (char-* or img-*) — the two on-screen subjects to swap in each chunk`),
    },
    handler: async (args) => {
      const {
        source_asset_id,
        project_slug,
        character_asset_ids,
      } = args as {
        source_asset_id: string;
        project_slug: string;
        character_asset_ids: string[];
      };

      const sourceAssetId = source_asset_id.replace(/^@/, "");

      if (!process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      if (character_asset_ids.length !== REQUIRED_CHARACTERS) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Exactly ${REQUIRED_CHARACTERS} character_asset_ids required (got ${character_asset_ids.length}). The pipeline swaps two on-screen subjects per chunk.`,
          }],
        };
      }

      const loaded = await loadAssetForAnalysis(fs, sourceAssetId, project_slug);
      if (!loaded.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: loaded.error.message }],
        };
      }
      if (loaded.value.transcript.source !== "elevenlabs") {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Plan visualization needs word-level timings (elevenlabs.json) but ${sourceAssetId} only has a ${loaded.value.transcript.source} transcript. Run /transcribe @${sourceAssetId} first.`,
          }],
        };
      }

      const characterIds = character_asset_ids.map((id) => id.replace(/^@/, ""));
      const characters: CharacterContext[] = [];
      for (const charId of characterIds) {
        const character = await loadCharacter(fs, charId, project_slug);
        if (!character) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Character asset not found: ${charId}` }],
          };
        }
        characters.push(character);
      }

      // Persist a skeleton sidecar now so /plan shows the source, cast, and
      // analysis prompt (with a loader) immediately, while the background job
      // produces the scenes. Best-effort: if the write fails the work area just
      // waits for the job's own write instead. The job overwrites it on success.
      const skeleton = buildSkeletonPlanSidecar(sourceAssetId, characters);
      const projectResult = await fs.getProject(project_slug);
      if (projectResult.ok) {
        await mkdir(join(projectResult.value.path, "plan"), { recursive: true });
        await fs.writeFile("plan", ".plan.json", JSON.stringify(skeleton, null, 2), project_slug);
      }

      const jobId = `plan-visualization-${sourceAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "plan_visualization",
        assetId: sourceAssetId,
        assetDir: loaded.value.manifest.path,
        projectSlug: project_slug,
        characterAssetIds: characterIds,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: sourceAssetId, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}
