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

export const SYSTEM_PROMPT_PLAN = `You produce one cinematic prompt per pre-computed video chunk. Each prompt drives a two-stage pipeline: (1) image-to-image at 2K using the source video's aspect ratio swaps the on-screen subject(s) in the chunk's first and last frames with the matching reference character(s); (2) bytedance/seedance-2 then animates between those two edited frames using the chunk video as a motion reference and the chunk audio as a dialogue/timing reference.

INPUTS YOU RECEIVE:
- Two reference characters (by @asset_id). These REPLACE the original on-screen people. A chunk — and each individual frame within it — may show BOTH characters (a two-shot), exactly ONE (a single / close-up, or one side of a shot-reverse-shot), or neither (an insert or cutaway). Read the frames; never assume both characters are on screen.
- A pre-computed list of chunks. Each chunk is ${MIN_SCENE_S}–${MAX_SCENE_S}s wide (variable, aligned to silence gaps in the transcript where possible) with explicit start/end and the transcript words spoken inside it.
- A SPEECH TIMELINE per chunk: whether the OPENING frame and the CLOSING frame land on speech or on silence, the speaker turns with timestamps, and how many distinct speakers are heard. This is your ground truth for who (if anyone) is talking at the exact frames you anchor to — trust it over visual guesswork.
- Sampled frames from the source clip (image inputs). Each frame is labelled with its timestamp in the user message; map frames to chunks by timestamp to ground your descriptions in what actually appears on screen.

YOUR JOB:
For each chunk, return one "visual" — a single dense paragraph (60–110 words) that:

1. Names ONLY the character(s) actually visible by their @asset_id token verbatim — one @id in a single/close-up, both in a two-shot. Never use the human-readable name, and never force the absent character into a single shot. Downstream tools resolve @asset_id to the actual likeness.
2. Describes the cinematic SHOT — environment, lighting, color palette, mood, camera (lens, angle, motion), composition. Default to photorealistic, 8k, shallow depth of field. Anchor to what the sampled frames actually show in this chunk's time window.
3. Decides TALKING vs LISTENING for the opening frame and the closing frame SEPARATELY, and states each explicitly. A subject is talking only if mid-speech — mouth open, jaw in motion. Otherwise they are silent: mouth closed, listening, reacting, or between lines. Ground this in BOTH the frame and the speech timeline: if the timeline marks a boundary frame SILENT, the subject there is closed-mouthed and listening — describe them that way and NEVER as mid-sentence. The opening frame is frequently a silent reaction beat; do not default it to talking. In a single shot the on-screen subject is talking only while it is their turn in the timeline.
4. Describes the ACTION across the chunk as motion between a "first beat" (frame 0 of the chunk) and a "final beat" (last frame of the chunk). Seedance interpolates between the two edited reference frames, so the arc — including each subject's talking/listening state at each end — must be explicit.
5. Handles CAMERA CHANGES inside the chunk. A chunk may span more than one camera setup — a hard cut, angle change, push-in, reframe, or a cut between single shots (shot-reverse-shot). Read the sampled frames in timestamp order: if the FIRST and LAST frames are clearly different shots (different angle, framing, or which subject is on screen), do NOT describe a single continuous take — write the visual as a deliberate move or cut between the two setups, anchoring the "first beat" to the opening frame and the "final beat" to the closing frame so the two edited reference frames read as the genuine endpoints. Examples: "opens on a single of @<charA-id> closed-mouthed and listening, then cuts to a tight single of @<charB-id> mid-sentence"; or "holds a two-shot as @<charA-id> talks and @<charB-id> reacts in profile". If every sampled frame shares one camera setup AND the same subject configuration, treat the chunk as a single continuous shot.
6. Locks identity: for each character you place on screen, include "lock the appearance of @<id> to its reference image". The edited frames go in reference_image_urls (NOT first_frame_url / last_frame_url — those are mutually exclusive with the multimodal reference fields and would be rejected by the Seedance 2 schema).
7. Honors the chunk's audio: dialogue, pacing, and audible action cues from the transcript drive what the characters DO. Match on-screen action to the words spoken in this chunk and to the speech timeline's turn boundaries.
8. Concrete > abstract. If the chunk's words are metaphorical, render the metaphor literally and visually.

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

// Skeleton index.md written the moment a char_swap plan is requested, alongside
// the skeleton .plan.json. videocity-engine's computeAssetStatus treats the
// `plan` singleton as "ready" ONLY once `index.md` exists; before it lands the
// plan dir holds just .plan.json (no media, no lock, no pending row for `plan` —
// the gen job leases the source video, not the plan), so the asset falls through
// computeAssetStatus's orphan fallback to "error" and the @plan sidebar card
// renders red for the whole draft/generation window. Writing a placeholder
// index.md now keeps the card out of that false-error state; the job overwrites
// it with the full per-chunk markdown on completion. Mirrors the header
// renderMarkdown() produces in jobs/plan-visualization.ts, minus the scenes.
export function buildSkeletonPlanMarkdown(sourceAssetId: string, characters: CharacterContext[]): string {
  const charLine = characters.map((c) => `@${c.asset_id} (${c.name})`).join(", ");
  return [
    "# Plan: gpt-image-2 + Seedance 2 remix",
    "",
    `**Source:** ${sourceAssetId}`,
    `**Characters:** ${charLine}`,
    `**Model:** ${MODEL}`,
    "",
    "_Preparing the plan — per-chunk visuals appear here once generation runs._",
    "",
  ].join("\n");
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

// Lead-in / tail-out silence threshold. When the gap between a chunk boundary and
// the nearest spoken word meets this, the boundary FRAME the swap pipeline edits
// (image1 at chunk.start, image2 just before chunk.end) is a silent beat — the
// on-screen subject is listening/reacting, not mid-speech.
const BOUNDARY_SILENCE_S = 0.4;

// Mid-chunk gap that breaks one speaker turn from the next in the timeline.
const TURN_SILENCE_S = 0.5;

// Group a chunk's words into speaker turns with absolute timestamps, emitting a
// "[silence Xs]" marker for every gap that exceeds TURN_SILENCE_S. speaker_id is
// optional (diarization may be off); it falls back to "?".
function groupSpeakerTurns(words: ElevenLabsWord[]): string[] {
  const lines: string[] = [];
  let speaker: string | undefined;
  let turnStart = 0;
  let buffer: string[] = [];
  let prevEnd: number | null = null;

  const flush = () => {
    if (buffer.length === 0) return;
    lines.push(`  @${turnStart.toFixed(2)}s spk=${speaker ?? "?"}: ${buffer.join(" ")}`);
    buffer = [];
  };

  for (const w of words) {
    if (prevEnd !== null && w.start - prevEnd > TURN_SILENCE_S) {
      flush();
      lines.push(`  [silence ${(w.start - prevEnd).toFixed(2)}s]`);
      speaker = undefined;
    }
    if (w.speaker_id !== speaker) {
      flush();
      speaker = w.speaker_id;
      turnStart = w.start;
    }
    if (buffer.length === 0) turnStart = w.start;
    buffer.push(w.text.trim());
    prevEnd = w.end;
  }
  flush();
  return lines;
}

// Speaker- and timing-aware breakdown of a chunk's dialog. Where dialogForChunk
// flattens words into one string, this surfaces the two signals the analysis
// model is otherwise blind to: (a) whether the opening and closing frames — the
// exact frames the i2i swap edits — land on speech or silence, the single most
// reliable cue for "is the subject talking in the frame we're about to bake?";
// and (b) how many distinct speakers are heard and when, so the model can infer
// shot/reverse-shot structure instead of forcing a two-shot. Degrades gracefully
// when diarization is off (no speaker_id) — the boundary silence still holds.
export function speechTimelineForChunk(words: ElevenLabsWord[], chunk: Chunk): string {
  const inChunk = words
    .filter((w) => w.type === "word")
    .filter((w) => w.start >= chunk.start && w.start < chunk.end);
  if (inChunk.length === 0) {
    return "Speech timeline: silent throughout — no words land in this chunk. Both the opening and closing frames are wordless beats (reaction, action, or B-roll); no one is talking.";
  }

  const firstWord = inChunk[0];
  const lastWord = inChunk[inChunk.length - 1];
  const leadIn = firstWord.start - chunk.start;
  const tail = chunk.end - lastWord.end;
  const openState = leadIn >= BOUNDARY_SILENCE_S
    ? `SILENT — ${leadIn.toFixed(2)}s of lead-in before the first word at ${firstWord.start.toFixed(2)}s; treat the opening frame as a non-talking, listening/reaction beat`
    : `speech already active (first word at ${firstWord.start.toFixed(2)}s)`;
  const closeState = tail >= BOUNDARY_SILENCE_S
    ? `SILENT — last word ends at ${lastWord.end.toFixed(2)}s, ${tail.toFixed(2)}s before the close; the closing frame is a non-talking beat`
    : `speech runs to the close (last word ends at ${lastWord.end.toFixed(2)}s)`;

  const speakerIds = [...new Set(inChunk.map((w) => w.speaker_id).filter((s): s is string => Boolean(s)))];
  const speakerLine = speakerIds.length >= 2
    ? `Distinct speakers heard: ${speakerIds.length} (${speakerIds.join(", ")}) — turns alternate, so the camera likely cuts between single shots, one speaker per shot.`
    : speakerIds.length === 1
      ? `Distinct speakers heard: 1 (${speakerIds[0]}).`
      : "Speaker labels unavailable (no diarization) — infer who is on screen from the frames.";

  return [
    `Speech timeline (absolute seconds; chunk opens @${chunk.start.toFixed(2)}s, closes @${chunk.end.toFixed(2)}s):`,
    `  opening frame @${chunk.start.toFixed(2)}s: ${openState}`,
    ...groupSpeakerTurns(inChunk),
    `  closing frame @${chunk.end.toFixed(2)}s: ${closeState}`,
    `  ${speakerLine}`,
  ].join("\n");
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
    const chunkFrameTs = sampledFrames
      .filter((f) => f.sceneIdx === i)
      .map((f) => `${f.t.toFixed(2)}s`)
      .join(", ");
    return [
      `Chunk ${i + 1}: ${c.start.toFixed(2)}s – ${c.end.toFixed(2)}s (${(c.end - c.start).toFixed(2)}s)`,
      speechTimelineForChunk(words, c),
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
      defer: z
        .boolean()
        .optional()
        .describe("When true, write the draft skeleton (source + cast + analysis prompt) but DO NOT enqueue the vision job — the user reviews the prompt in /plan and starts generation explicitly. Default false (generate immediately)."),
    },
    handler: async (args) => {
      const {
        source_asset_id,
        project_slug,
        character_asset_ids,
        defer,
      } = args as {
        source_asset_id: string;
        project_slug: string;
        character_asset_ids: string[];
        defer?: boolean;
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
      // `awaiting_start` marks a draft the user can read before generation runs;
      // the work area shows a "Generate plan" button instead of polling. A
      // non-deferred call (the explicit Generate / a regenerate) omits it and
      // enqueues immediately; the job overwrites the skeleton with real scenes.
      const skeleton = {
        ...buildSkeletonPlanSidecar(sourceAssetId, characters),
        ...(defer ? { awaiting_start: true } : {}),
      };
      const projectResult = await fs.getProject(project_slug);
      if (projectResult.ok) {
        await mkdir(join(projectResult.value.path, "plan"), { recursive: true });
        await fs.writeFile("plan", ".plan.json", JSON.stringify(skeleton, null, 2), project_slug);
        // index.md must exist for the plan asset to read as "ready" rather than
        // orphan-"error" while the job generates the real plan (see
        // buildSkeletonPlanMarkdown). The job overwrites it on completion.
        await fs.writeFile("plan", "index.md", buildSkeletonPlanMarkdown(sourceAssetId, characters), project_slug);
      }

      if (defer) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ asset_id: sourceAssetId, status: "draft" }),
          }],
        };
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
