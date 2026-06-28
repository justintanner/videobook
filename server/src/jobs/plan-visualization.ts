import type { VideocityFs } from "videocity-engine";
import { findVideoFile } from "videocity-engine";
import { join } from "node:path";
import { readFile as fsReadFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import type { KieGeminiPart } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { getApiKey } from "../api-key.js";
import { ensureElevenLabsTranscript } from "./_transcribe.js";
import { withLocalLease } from "./_lease.js";
import { probeVideo } from "../ffmpeg.js";
import { detectSceneCandidates } from "../scene-detect.js";
import { loadAssetForAnalysis } from "../tools/_suggest-shared.js";
import {
  CHAR_SWAP_PLAN_MODEL,
  MIN_SCENE_S,
  MAX_SCENE_S,
  SYSTEM_PROMPT_PLAN,
  VISUALS_JSON_SCHEMA,
  VisualsSchema,
  buildPlanContext,
  coerceVisualsPayload,
  computeChunks,
  dialogForChunk,
  loadCharacter,
  sampleFramesForScenes,
  type CharacterContext,
} from "../tools/plan-visualization.js";
import { callGeminiFlashJson, geminiImageBase64Part, geminiTextPart } from "../kie-gemini.js";
import { startPlanProgress, updatePlanProgress, finishPlanProgress } from "../plan-progress.js";

const execFileAsync = promisify(execFile);
const planVisRequire = createRequire(import.meta.url);
const FFMPEG: string = planVisRequire("ffmpeg-static");

type PlanVisualizationPayload = {
  type: "plan_visualization";
  assetId: string;
  assetDir: string;
  projectSlug: string;
  characterAssetIds: string[];
};

type Scene = {
  start: number;
  end: number;
  visual: string;
  dialog: string;
  clip_filename: string;
  audio_filename: string;
  frames: Array<{ name: string; t: number }>;
};

const FRAME_TAIL = ["-frames:v", "1", "-q:v", "2", "-update", "1"];

// Run one ffmpeg single-frame grab. Returns the JPEG bytes, or null when ffmpeg
// errors or writes an empty file — callers chain progressively safer seeks
// rather than treating an empty grab as fatal.
async function runFrameGrab(args: string[], outPath: string): Promise<Buffer | null> {
  try {
    await execFileAsync(FFMPEG, args);
  } catch {
    return null;
  }
  const outStat = await stat(outPath).catch(() => null);
  if (!outStat || outStat.size === 0) return null;
  return readFile(outPath);
}

// A frame at an exact timestamp known to be within the clip. Fast input-seek
// first, then an accurate (decode-from-start) output-seek fallback for codecs —
// notably AV1 — where input-seek near a boundary yields an empty packet.
async function grabFrameAt(videoPath: string, timestamp: number, outPath: string): Promise<Buffer | null> {
  return (
    (await runFrameGrab(["-y", "-ss", String(timestamp), "-i", videoPath, ...FRAME_TAIL, outPath], outPath)) ??
    (await runFrameGrab(["-y", "-i", videoPath, "-ss", String(timestamp), ...FRAME_TAIL, outPath], outPath))
  );
}

// The clip's final frame, seeked relative to EOF so it never overshoots the last
// decodable PTS. A container's duration can run past its last video frame (an
// audio tail, or AV1 packaging), so an absolute seek to ~duration produces an
// empty output; -sseof lands on a real frame regardless.
async function grabLastFrame(videoPath: string, outPath: string): Promise<Buffer | null> {
  return (
    (await runFrameGrab(["-y", "-sseof", "-0.2", "-i", videoPath, ...FRAME_TAIL, outPath], outPath)) ??
    (await grabFrameAt(videoPath, 0, outPath))
  );
}

// Extract one scene frame to plan/sN-imageM-source.jpg. Best-effort per frame: a
// failure logs and leaves that one frame as the client's "no source frame"
// placeholder rather than aborting extraction of the others.
async function writeSceneSourceFrame(
  fs: VideocityFs,
  projectSlug: string,
  sceneIndex: number,
  frameIndex: 1 | 2,
  grab: (outPath: string) => Promise<Buffer | null>,
): Promise<void> {
  const fileName = `s${sceneIndex + 1}-image${frameIndex}-source.jpg`;
  const temp = join(tmpdir(), `videocity-plan-${sceneIndex}-${frameIndex}-${Date.now()}.jpg`);
  try {
    const buf = await grab(temp);
    if (!buf) {
      console.warn(`[plan_visualization] ${fileName}: ffmpeg produced no frame`);
      return;
    }
    const written = await fs.writeFile("plan", fileName, buf, projectSlug);
    if (!written.ok) console.warn(`[plan_visualization] ${fileName}: ${written.error.message}`);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function planFrameFileSet(fs: VideocityFs, projectSlug: string): Promise<Set<string>> {
  const manifest = await fs.getManifest("plan", projectSlug, { includeDotfiles: false });
  if (!manifest.ok) return new Set();
  return new Set(manifest.value.files.map((f) => f.name));
}

// Per scene N (1-based), write plan/sN-image1-source.jpg (first frame) and
// plan/sN-image2-source.jpg (last frame). The final scene's last frame is taken
// relative to EOF — its end equals the source duration, which can overshoot the
// last real frame. The PlanViewer scene blocks address these via
// `@plan/sN-imageM-source.jpg`. With `skipExisting`, only frames not already on
// disk are extracted, so re-runs (the client's self-heal backfill) are idempotent.
export async function extractSceneSourceFrames(
  fs: VideocityFs,
  projectSlug: string,
  videoPath: string,
  scenes: Array<{ start: number; end: number }>,
  options: { skipExisting?: boolean } = {},
): Promise<void> {
  const present = options.skipExisting ? await planFrameFileSet(fs, projectSlug) : new Set<string>();
  for (let i = 0; i < scenes.length; i++) {
    const isFinal = i === scenes.length - 1;
    if (!present.has(`s${i + 1}-image1-source.jpg`)) {
      await writeSceneSourceFrame(fs, projectSlug, i, 1, (out) => grabFrameAt(videoPath, scenes[i].start, out));
    }
    if (!present.has(`s${i + 1}-image2-source.jpg`)) {
      const lastTs = Math.max(0, scenes[i].end - 0.05);
      await writeSceneSourceFrame(fs, projectSlug, i, 2, (out) =>
        isFinal ? grabLastFrame(videoPath, out) : grabFrameAt(videoPath, lastTs, out));
    }
  }
}

function renderMarkdown(
  sourceAssetId: string,
  totalDuration: number,
  characters: CharacterContext[],
  model: string,
  scenes: Scene[],
): string {
  const charLine = characters.map((c) => `@${c.asset_id} (${c.name})`).join(", ");

  const header = [
    "# Plan: gpt-image-2 + Seedance 2 remix",
    "",
    `**Source:** ${sourceAssetId}`,
    `**Duration:** ${totalDuration.toFixed(2)}s`,
    `**Chunks:** ${scenes.length} (${MIN_SCENE_S}–${MAX_SCENE_S}s each, shot-aligned)`,
    `**Characters:** ${charLine}`,
    `**Model:** ${model}`,
    "",
    "Per chunk: extract first/last frames → swap the two on-screen subjects with the two characters via image-to-image (2K, source aspect) → assemble bytedance/seedance-2 multimodal call (edited frames as `reference_image_urls`, chunk video as `reference_video_urls`, chunk audio as `reference_audio_urls`).",
    "",
    "---",
    "",
  ].join("\n");

  const blocks = scenes.map((s, i) => {
    const duration = (s.end - s.start).toFixed(2);
    return [
      `## Chunk ${i + 1} — ${s.start.toFixed(2)}s – ${s.end.toFixed(2)}s (${duration}s)`,
      "",
      s.visual,
      "",
    ].join("\n");
  });

  return header + blocks.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function markPlanFailed(
  fs: VideocityFs,
  projectSlug: string,
  sourceAssetId: string,
  error: unknown,
): Promise<void> {
  const read = await fs.readMetadata<Record<string, unknown>>("plan", "plan", projectSlug);
  const current = read.ok && isRecord(read.value) ? read.value : {};
  if (
    typeof current.source_asset_id === "string" &&
    current.source_asset_id.length > 0 &&
    current.source_asset_id !== sourceAssetId
  ) {
    return;
  }

  const projectResult = await fs.getProject(projectSlug);
  if (!projectResult.ok) return;
  await mkdir(join(projectResult.value.path, "plan"), { recursive: true });

  const sidecar = {
    ...current,
    formula: "char_swap",
    scenes: Array.isArray(current.scenes) ? current.scenes : [],
    source_asset_id: sourceAssetId,
    total_duration_s: typeof current.total_duration_s === "number" ? current.total_duration_s : 0,
    max_scene_seconds: typeof current.max_scene_seconds === "number" ? current.max_scene_seconds : MAX_SCENE_S,
    characters: Array.isArray(current.characters) ? current.characters : [],
    model: typeof current.model === "string" ? current.model : CHAR_SWAP_PLAN_MODEL,
    analysis_prompt: typeof current.analysis_prompt === "string" ? current.analysis_prompt : SYSTEM_PROMPT_PLAN,
    generation_status: "failed",
    generation_error: errorMessage(error),
    failed_at: new Date().toISOString(),
    awaiting_start: false,
  };
  await fs.writeFile("plan", ".plan.json", JSON.stringify(sidecar, null, 2), projectSlug);
}

type EnsurePlanSourceFramesPayload = {
  type: "ensure_plan_source_frames";
  projectSlug: string;
};

// Idempotent backfill: extract any per-scene source frames missing from a
// finished plan (e.g. a flaky ffmpeg run at /plan-vis time left them out, or the
// plan predates source-frame extraction). Reads the committed .plan.json for the
// scene boundaries + source asset, then fills only the frames not already on
// disk. The client's scene-files bootstrap calls this when a plan opens with
// missing frames, so plans self-heal without a full re-vision.
export function registerEnsurePlanSourceFramesJob(fs: VideocityFs): void {
  registerJobHandler("ensure_plan_source_frames", async (payload) => {
    const { projectSlug } = payload as EnsurePlanSourceFramesPayload;
    const read = await fs.readMetadata<Record<string, unknown>>("plan", "plan", projectSlug);
    if (!read.ok) return { success: true, extracted: 0, reason: "no plan sidecar" };

    const sidecar = read.value;
    const scenes = Array.isArray(sidecar.scenes)
      ? (sidecar.scenes as Array<{ start: number; end: number }>)
      : [];
    const sourceAssetId = typeof sidecar.source_asset_id === "string" ? sidecar.source_asset_id : "";
    if (scenes.length === 0 || !sourceAssetId) return { success: true, extracted: 0 };

    const videoManifest = await fs.getManifest(sourceAssetId, projectSlug, { includeDotfiles: false });
    if (!videoManifest.ok) throw new Error(videoManifest.error.message);
    const videoFile = findVideoFile(videoManifest.value.files);
    if (!videoFile) throw new Error(`No video file found in asset ${sourceAssetId}`);
    const videoFsPath = join(videoManifest.value.path, videoFile.name);

    await extractSceneSourceFrames(fs, projectSlug, videoFsPath, scenes, { skipExisting: true });
    return { success: true };
  });
}

export function registerPlanVisualizationJob(fs: VideocityFs): void {
  registerJobHandler("plan_visualization", async (payload, ctx) => {
    const { assetId: sourceAssetId, projectSlug, characterAssetIds } = payload as PlanVisualizationPayload;

    return withLocalLease(fs, projectSlug, sourceAssetId, ctx, "analyze", async () => {
      try {
        const apiKey = getApiKey("KIE_API_KEY");
        if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

        let loaded = await loadAssetForAnalysis(fs, sourceAssetId, projectSlug);
        if (!loaded.ok) throw new Error(loaded.error.message);
        if (loaded.value.transcript.source !== "elevenlabs") {
          // Auto-transcribe with ElevenLabs (word-level timings) inline rather
          // than failing — this job holds the asset's analyze lease, and
          // ensureElevenLabsTranscript is lease-agnostic. Mirrors render-project's
          // subtitle auto-transcribe. Throws (failing the plan) on missing audio /
          // API key / API error so the cause surfaces in the plan's failed state.
          await ensureElevenLabsTranscript(fs, projectSlug, sourceAssetId);
          loaded = await loadAssetForAnalysis(fs, sourceAssetId, projectSlug);
          if (!loaded.ok) throw new Error(loaded.error.message);
          if (loaded.value.transcript.source !== "elevenlabs") {
            throw new Error(
              `Auto-transcribe completed but ${sourceAssetId} still has no word-level timings (elevenlabs.json).`,
            );
          }
        }
        const { framesDir, frameNames, transcript } = loaded.value;

        const videoManifest = await fs.getManifest(sourceAssetId, projectSlug, { includeDotfiles: false });
        if (!videoManifest.ok) throw new Error(videoManifest.error.message);
        const videoFile = findVideoFile(videoManifest.value.files);
        if (!videoFile) throw new Error(`No video file found in asset ${sourceAssetId}`);
        const videoFsPath = join(videoManifest.value.path, videoFile.name);
        const totalDuration = (await probeVideo(videoFsPath)).duration;

        const characters: CharacterContext[] = [];
        for (const charId of characterAssetIds) {
          const character = await loadCharacter(fs, charId, projectSlug);
          if (!character) throw new Error(`Character asset not found: ${charId}`);
          characters.push(character);
        }

        const candidates = await detectSceneCandidates(videoFsPath);
        const chunks = computeChunks(totalDuration, candidates);
        if (chunks.length === 0) throw new Error("Could not compute chunks from source video");

        const sampled = sampleFramesForScenes(frameNames, chunks);
        const frameParts: KieGeminiPart[] = [];
        for (const f of sampled) {
          const buf = await fsReadFile(join(framesDir, f.name));
          frameParts.push(geminiImageBase64Part(buf.toString("base64"), "image/jpeg"));
        }

        const userContext = buildPlanContext(characters, chunks, transcript.words, sampled);
        const userContent: KieGeminiPart[] = [
          geminiTextPart(`Instructions:\n${SYSTEM_PROMPT_PLAN}`),
          geminiTextPart(userContext),
          ...frameParts,
        ];

        // Stream the model's output into the in-memory progress registry so the
        // client can render the analysis live (read_plan_progress). This is a
        // preview only; the authoritative scenes come from the parse below.
        startPlanProgress(projectSlug);
        const outputText = await callGeminiFlashJson({
          apiKey,
          parts: userContent,
          temperature: 0.5,
          maxOutputTokens: 8192,
          responseSchema: VISUALS_JSON_SCHEMA as unknown as Record<string, unknown>,
          onDelta: (text) => updatePlanProgress(projectSlug, text),
        });

        let visuals: { visual: string }[];
        try {
          visuals = VisualsSchema.parse(coerceVisualsPayload(JSON.parse(outputText))).visuals;
        } catch (err) {
          throw new Error(
            `Model output failed schema validation: ${errorMessage(err)} (raw output: ${outputText.slice(0, 300)})`,
          );
        }

        if (visuals.length !== chunks.length) {
          throw new Error(`Model returned ${visuals.length} visuals for ${chunks.length} chunks; expected one-to-one`);
        }

        const scenes: Scene[] = chunks.map((c, i) => ({
          start: c.start,
          end: c.end,
          visual: visuals[i].visual,
          dialog: dialogForChunk(transcript.words, c),
          clip_filename: `s${i + 1}.mp4`,
          audio_filename: `s${i + 1}.mp3`,
          frames: sampled
            .filter((f) => f.sceneIdx === i)
            .map((f) => ({ name: f.name, t: f.t })),
        }));

        const sidecar = {
          formula: "char_swap",
          scenes,
          source_asset_id: sourceAssetId,
          total_duration_s: totalDuration,
          max_scene_seconds: MAX_SCENE_S,
          characters,
          model: CHAR_SWAP_PLAN_MODEL,
          analysis_prompt: SYSTEM_PROMPT_PLAN,
          user_context: userContext,
          word_count: transcript.words.filter((w) => w.type === "word").length,
          generation_status: "ready",
        };

        const markdown = renderMarkdown(sourceAssetId, totalDuration, characters, CHAR_SWAP_PLAN_MODEL, scenes);

        const projectResult = await fs.getProject(projectSlug);
        if (!projectResult.ok) throw new Error(projectResult.error.message);
        await mkdir(join(projectResult.value.path, "plan"), { recursive: true });

        // Extract the per-scene source frames BEFORE writing .plan.json. The client's
        // scene-arrival poll renders the source-frame + swap nodes the instant the
        // sidecar reports scenes; if the JPEGs aren't on disk yet those <img> tags
        // 404 and stick on a "no source frame" placeholder (their cache-bust is the
        // stable scene start/end, so they never retry). Writing the frames first
        // makes "scenes present in sidecar" imply "source frames on disk". Frame
        // extraction is best-effort: a single ffmpeg failure degrades that one frame
        // to the placeholder rather than aborting the whole plan.
        try {
          await extractSceneSourceFrames(fs, projectSlug, videoFsPath, scenes);
        } catch (err) {
          console.warn(`[plan_visualization] source-frame extraction failed for ${sourceAssetId}: ${errorMessage(err)}`);
        }

        const writeMd = await fs.writeFile("plan", "index.md", markdown, projectSlug);
        if (!writeMd.ok) throw new Error(`Failed to write index.md: ${writeMd.error.message}`);

        const writeJson = await fs.writeFile("plan", ".plan.json", JSON.stringify(sidecar, null, 2), projectSlug);
        if (!writeJson.ok) throw new Error(`Failed to write .plan.json: ${writeJson.error.message}`);

        finishPlanProgress(projectSlug, "done");

        return {
          success: true,
          scenes: scenes.length,
          total_duration_s: totalDuration,
          model: CHAR_SWAP_PLAN_MODEL,
        };
      } catch (error) {
        finishPlanProgress(projectSlug, "failed", errorMessage(error));
        await markPlanFailed(fs, projectSlug, sourceAssetId, error);
        throw error;
      }
    });
  });
}
