import type { VideocityFs } from "videocity-engine";
import { findVideoFile } from "videocity-engine";
import { z } from "zod";
import { join } from "node:path";
import { readFile as fsReadFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createOpenAi, withRetry, textPart, imageBase64Part, firstContent } from "@apicity/openai";
import type { OpenAiContentPart } from "@apicity/openai";
import { registerJobHandler } from "../queue.js";
import { getApiKey } from "../api-key.js";
import { withLocalLease } from "./_lease.js";
import { probeVideo } from "../ffmpeg.js";
import { detectSceneCandidates } from "../scene-detect.js";
import { MODEL, loadAssetForAnalysis } from "../tools/_suggest-shared.js";
import {
  MIN_SCENE_S,
  MAX_SCENE_S,
  SYSTEM_PROMPT_PLAN,
  buildPlanContext,
  computeChunks,
  loadCharacter,
  sampleFramesForScenes,
  type CharacterContext,
} from "../tools/plan-visualization.js";

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
  clip_filename: string;
  audio_filename: string;
  frames: Array<{ name: string; t: number }>;
};

const VisualsSchema = z.object({
  visuals: z.array(z.object({ visual: z.string().min(20) })).min(1),
});

const VISUALS_JSON_SCHEMA = {
  type: "object",
  required: ["visuals"],
  additionalProperties: false,
  properties: {
    visuals: {
      type: "array",
      items: {
        type: "object",
        required: ["visual"],
        additionalProperties: false,
        properties: { visual: { type: "string" } },
      },
    },
  },
} as const;

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

export function registerPlanVisualizationJob(fs: VideocityFs): void {
  registerJobHandler("plan_visualization", async (payload, ctx) => {
    const { assetId: sourceAssetId, projectSlug, characterAssetIds } = payload as PlanVisualizationPayload;

    return withLocalLease(fs, projectSlug, sourceAssetId, ctx, "analyze", async () => {
      const apiKey = getApiKey("OPENAI_API_KEY");
      if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is not set");

      const loaded = await loadAssetForAnalysis(fs, sourceAssetId, projectSlug);
      if (!loaded.ok) throw new Error(loaded.error.message);
      const { framesDir, frameNames, transcript } = loaded.value;
      if (transcript.source !== "elevenlabs") {
        throw new Error(
          `Plan visualization needs word-level timings (elevenlabs.json) but ${sourceAssetId} only has a ${transcript.source} transcript. Run /transcribe @${sourceAssetId} first.`,
        );
      }

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
      const frameParts: OpenAiContentPart[] = [];
      for (const f of sampled) {
        const buf = await fsReadFile(join(framesDir, f.name));
        frameParts.push(imageBase64Part(buf.toString("base64"), "image/jpeg", "low"));
      }

      const userContext = buildPlanContext(characters, chunks, transcript.words, sampled);
      const userContent: OpenAiContentPart[] = [
        textPart(userContext),
        ...frameParts,
      ];

      const provider = createOpenAi({ apiKey, timeout: 240_000 });
      const call = withRetry(provider.post.v1.chat.completions, { retries: 2, baseMs: 500 });

      const result = await call({
        model: MODEL,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT_PLAN },
          { role: "user", content: userContent },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "plan_visualization_visuals",
            schema: VISUALS_JSON_SCHEMA as unknown as Record<string, unknown>,
            strict: true,
          },
        },
        temperature: 0.5,
        max_completion_tokens: 8192,
      });
      const outputText = firstContent(result);

      let visuals: { visual: string }[];
      try {
        visuals = VisualsSchema.parse(JSON.parse(outputText)).visuals;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Model output failed schema validation: ${msg}`);
      }

      if (visuals.length !== chunks.length) {
        throw new Error(`Model returned ${visuals.length} visuals for ${chunks.length} chunks; expected one-to-one`);
      }

      const scenes: Scene[] = chunks.map((c, i) => ({
        start: c.start,
        end: c.end,
        visual: visuals[i].visual,
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
        model: MODEL,
        analysis_prompt: SYSTEM_PROMPT_PLAN,
        user_context: userContext,
        word_count: transcript.words.filter((w) => w.type === "word").length,
      };

      const markdown = renderMarkdown(sourceAssetId, totalDuration, characters, MODEL, scenes);

      const projectResult = await fs.getProject(projectSlug);
      if (!projectResult.ok) throw new Error(projectResult.error.message);
      await mkdir(join(projectResult.value.path, "plan"), { recursive: true });

      const writeMd = await fs.writeFile("plan", "index.md", markdown, projectSlug);
      if (!writeMd.ok) throw new Error(`Failed to write index.md: ${writeMd.error.message}`);

      const writeJson = await fs.writeFile("plan", ".plan.json", JSON.stringify(sidecar, null, 2), projectSlug);
      if (!writeJson.ok) throw new Error(`Failed to write .plan.json: ${writeJson.error.message}`);

      await extractSceneSourceFrames(fs, projectSlug, videoFsPath, scenes);

      return {
        success: true,
        scenes: scenes.length,
        total_duration_s: totalDuration,
        model: MODEL,
      };
    });
  });
}
