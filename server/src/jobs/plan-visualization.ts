import type { VideocityFs } from "videocity-engine";
import { findVideoFile } from "videocity-engine";
import { z } from "zod";
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
  buildPlanContext,
  computeChunks,
  dialogForChunk,
  loadCharacter,
  sampleFramesForScenes,
  type CharacterContext,
} from "../tools/plan-visualization.js";
import { callGeminiFlashJson, geminiImageBase64Part, geminiTextPart } from "../kie-gemini.js";

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

const VisualsSchema = z.object({
  visuals: z.array(z.object({ visual: z.string().min(20) })).min(1),
});

async function extractFrameJpeg(inputPath: string, timestamp: number, outPath: string): Promise<Buffer> {
  try {
    await execFileAsync(FFMPEG, [
      "-y",
      "-ss", String(timestamp),
      "-i", inputPath,
      "-frames:v", "1",
      "-q:v", "2",
      outPath,
    ]);
  } catch (error) {
    const msg = error instanceof Error ? (error as Error & { stderr?: string }).stderr ?? error.message : String(error);
    throw new Error(`ffmpeg failed at t=${timestamp}s: ${msg}`);
  }
  const outStat = await stat(outPath).catch(() => null);
  if (!outStat || outStat.size === 0) {
    throw new Error(`ffmpeg produced no output at t=${timestamp}s`);
  }
  return readFile(outPath);
}

// Per scene N (1-based), write plan/sN-image1-source.jpg (first frame) and
// plan/sN-image2-source.jpg (last frame, ε before the boundary so we don't
// fall off the end). The PlanViewer scene blocks address these via
// `@plan/sN-imageM-source.jpg`.
async function extractSceneSourceFrames(
  fs: VideocityFs,
  projectSlug: string,
  videoPath: string,
  scenes: Array<{ start: number; end: number }>,
): Promise<void> {
  for (let i = 0; i < scenes.length; i++) {
    const { start, end } = scenes[i];
    const lastTs = Math.max(0, end - 0.05);
    const tempFirst = join(tmpdir(), `videocity-plan-${i}-1-${Date.now()}.jpg`);
    const tempLast = join(tmpdir(), `videocity-plan-${i}-2-${Date.now()}.jpg`);
    try {
      const firstBuf = await extractFrameJpeg(videoPath, start, tempFirst);
      const lastBuf = await extractFrameJpeg(videoPath, lastTs, tempLast);
      const w1 = await fs.writeFile("plan", `s${i + 1}-image1-source.jpg`, firstBuf, projectSlug);
      if (!w1.ok) throw new Error(`scene ${i + 1} image1: ${w1.error.message}`);
      const w2 = await fs.writeFile("plan", `s${i + 1}-image2-source.jpg`, lastBuf, projectSlug);
      if (!w2.ok) throw new Error(`scene ${i + 1} image2: ${w2.error.message}`);
    } finally {
      await rm(tempFirst, { force: true }).catch(() => {});
      await rm(tempLast, { force: true }).catch(() => {});
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

        const outputText = await callGeminiFlashJson({
          apiKey,
          parts: userContent,
          temperature: 0.5,
          maxOutputTokens: 8192,
        });

        let visuals: { visual: string }[];
        try {
          visuals = VisualsSchema.parse(JSON.parse(outputText)).visuals;
        } catch (err) {
          throw new Error(`Model output failed schema validation: ${errorMessage(err)}`);
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

        return {
          success: true,
          scenes: scenes.length,
          total_duration_s: totalDuration,
          model: CHAR_SWAP_PLAN_MODEL,
        };
      } catch (error) {
        await markPlanFailed(fs, projectSlug, sourceAssetId, error);
        throw error;
      }
    });
  });
}
