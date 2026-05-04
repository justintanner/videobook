import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
import { findAudioFile, findVideoFile } from "clipfirst-engine";
import { z } from "zod";
import { join } from "node:path";
import { readFile as fsReadFile, mkdir } from "node:fs/promises";
import { openai, withRetry, textPart, imageBase64Part, firstContent } from "@apicity/openai";
import type { OpenAiContentPart } from "@apicity/openai";
import { queue } from "../queue.js";
import { probeVideo } from "../ffmpeg.js";
import type { ToolDef } from "./tool-def.js";
import {
  MODEL,
  decodeBuffer,
  loadAssetForAnalysis,
  sampleFrames,
  type ElevenLabsWord,
} from "./_suggest-shared.js";

const CHUNK_S = 15;
const REQUIRED_CHARACTERS = 2;

type CharacterContext = {
  asset_id: string;
  name: string;
  description: string;
};

type Chunk = {
  start: number;
  end: number;
};

type Scene = {
  start: number;
  end: number;
  visual: string;
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

const SYSTEM_PROMPT_PLAN = `You produce one cinematic prompt per pre-computed video chunk. Each prompt drives a two-stage pipeline: (1) gpt-image-2-image-to-image at 2K, 16:9 swaps the two on-screen subjects in the chunk's first and last frames with the two reference characters; (2) bytedance/seedance-2 then animates between those two edited frames using the chunk video as a motion reference and the chunk audio as a dialogue/timing reference.

INPUTS YOU RECEIVE:
- Two characters (exactly two, by @asset_id) — these REPLACE the two main on-screen subjects in every chunk.
- A pre-computed list of chunks. Each chunk has a fixed start/end (${CHUNK_S}s wide; the final chunk may be shorter) and the transcript words spoken inside it.
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

async function loadCharacter(
  fs: ClipfirstFs,
  charId: string,
  projectSlug: string,
): Promise<CharacterContext | null> {
  const cleanId = charId.replace(/^@/, "");
  const manifestResult = await fs.getManifest(cleanId, projectSlug, { includeDotfiles: true });
  if (!manifestResult.ok) return null;

  const files = manifestResult.value.files;
  let name = cleanId.replace(/^char-/, "");
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

// Cover the whole clip in fixed CHUNK_S slabs from t=0. The final slab is the
// remainder, so all but the last chunk are exactly CHUNK_S long.
function computeChunks(duration: number): Chunk[] {
  if (duration <= 0) return [];
  if (duration <= CHUNK_S) return [{ start: 0, end: duration }];
  const chunks: Chunk[] = [];
  let t = 0;
  while (duration - t > CHUNK_S) {
    chunks.push({ start: t, end: t + CHUNK_S });
    t += CHUNK_S;
  }
  chunks.push({ start: t, end: duration });
  return chunks;
}

function buildPlanContext(
  characters: CharacterContext[],
  chunks: Chunk[],
  words: ElevenLabsWord[],
  sampledFrameNames: string[],
): string {
  const charBlock = characters
    .map((c, i) => `  ${i + 1}. @${c.asset_id} (also known as: ${c.name}) — ${c.description || "(no description)"}`)
    .join("\n");

  const wordsOnly = words.filter((w) => w.type === "word");
  const chunkBlocks = chunks.map((c, i) => {
    const inChunk = wordsOnly.filter((w) => w.start >= c.start && w.start < c.end);
    const text = inChunk.map((w) => w.text).join(" ").trim() || "(no speech in this chunk)";
    return [
      `Chunk ${i + 1}: ${c.start.toFixed(2)}s – ${c.end.toFixed(2)}s (${(c.end - c.start).toFixed(2)}s)`,
      `Transcript: ${text}`,
    ].join("\n");
  });

  const frameTimestamps = sampledFrameNames
    .map((name) => parseFloat(name).toFixed(2))
    .join(", ");

  return [
    `Characters (use the @asset_id token verbatim in every visual):`,
    charBlock,
    "",
    `Chunks (${chunks.length} total — produce one "visual" per chunk, in order):`,
    "",
    chunkBlocks.join("\n\n"),
    "",
    `Frame timestamps (in seconds, in the same order as the image inputs that follow): ${frameTimestamps}`,
  ].join("\n");
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
    `**Chunks:** ${scenes.length} (${CHUNK_S}s each except the last)`,
    `**Characters:** ${charLine}`,
    `**Model:** ${model}`,
    "",
    "Per chunk: extract first/last frames → swap the two on-screen subjects with the two characters via gpt-image-2-image-to-image (2K, 16:9) → assemble bytedance/seedance-2 multimodal call (edited frames as `reference_image_urls`, chunk video as `reference_video_urls`, chunk audio as `reference_audio_urls`).",
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

export function planVisualizationDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "plan_visualization",
    description:
      `Generate a per-chunk gpt-image-2 + Seedance 2 remix plan from a video asset. ` +
      `Splits the clip into fixed ${CHUNK_S}s chunks from the start (last chunk holds the remainder), samples frames + transcript across the clip, ` +
      `then asks an LLM to produce one cinematic Seedance 2 prompt per chunk that locks the two named characters to the chunk's first/last frame edits. ` +
      `Requires exactly ${REQUIRED_CHARACTERS} character assets (the two on-screen subjects to swap) and a transcribed video source (elevenlabs.json with word timings). ` +
      `Writes plan/index.md (human-readable) and plan/.plan.json (structured), overwriting prior.`,
    schema: {
      source_asset_id: z.string().describe("Video asset with elevenlabs.json (vid-* — word-level timings required)"),
      project_slug: z.string().describe("Project slug"),
      character_asset_ids: z
        .array(z.string())
        .length(REQUIRED_CHARACTERS)
        .describe(`Exactly ${REQUIRED_CHARACTERS} char-* assets — the two on-screen subjects to swap in each chunk`),
    },
    handler: async (args) => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

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
      let { framesDir, frameNames, transcript } = loaded.value;

      if (transcript.source !== "elevenlabs") {
        if (!process.env.ELEVENLABS_API_KEY) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Plan visualization needs word-level timings (elevenlabs.json) but ${sourceAssetId} only has a ${transcript.source} transcript, and ELEVENLABS_API_KEY is not set so we can't auto-transcribe. Set the key or run /transcribe manually.`,
            }],
          };
        }

        const manifestResult = await fs.getManifest(sourceAssetId, project_slug, { includeDotfiles: true });
        if (!manifestResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: manifestResult.error.message }],
          };
        }
        const audioFile = findAudioFile(manifestResult.value.files, sourceAssetId);
        if (!audioFile) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `No audio file found in asset ${sourceAssetId}; cannot auto-transcribe for plan visualization.` }],
          };
        }

        const jobId = `transcribe-${sourceAssetId}-${Date.now()}`;
        try {
          await queue.enqueueAndWait(
            jobId,
            {
              type: "transcribe",
              audioPath: join(manifestResult.value.path, audioFile.name),
              audioFilename: audioFile.name,
              tagAudioEvents: true,
              diarize: true,
              assetId: sourceAssetId,
              assetDir: manifestResult.value.path,
              projectSlug: project_slug,
            } as unknown as Record<string, unknown>,
            10 * 60_000,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Auto-transcribe failed for ${sourceAssetId}: ${msg}` }],
          };
        }

        const reloaded = await loadAssetForAnalysis(fs, sourceAssetId, project_slug);
        if (!reloaded.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: reloaded.error.message }],
          };
        }
        framesDir = reloaded.value.framesDir;
        frameNames = reloaded.value.frameNames;
        transcript = reloaded.value.transcript;
        if (transcript.source !== "elevenlabs") {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Auto-transcribe finished for ${sourceAssetId} but elevenlabs.json is still not loadable.`,
            }],
          };
        }
      }
      const videoManifest = await fs.getManifest(sourceAssetId, project_slug, { includeDotfiles: false });
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
          content: [{ type: "text" as const, text: `No video file found in asset ${sourceAssetId}` }],
        };
      }
      const probe = await probeVideo(join(videoManifest.value.path, videoFile.name));
      const totalDuration = probe.duration;

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

      const chunks = computeChunks(totalDuration);
      if (chunks.length === 0) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "Could not compute chunks from transcript" }],
        };
      }

      const sampled = sampleFrames(frameNames);
      const frameParts: OpenAiContentPart[] = [];
      for (const file of sampled) {
        const buf = await fsReadFile(join(framesDir, file));
        frameParts.push(imageBase64Part(buf.toString("base64"), "image/jpeg", "low"));
      }

      const userContent: OpenAiContentPart[] = [
        textPart(buildPlanContext(characters, chunks, transcript.words, sampled)),
        ...frameParts,
      ];

      const provider = openai({ apiKey, timeout: 240_000 });
      const call = withRetry(provider.post.v1.chat.completions, { retries: 2, baseMs: 500 });

      let outputText: string;
      try {
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
        outputText = firstContent(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `OpenAI call failed: ${msg}` }],
        };
      }

      let visuals: { visual: string }[];
      try {
        const raw = JSON.parse(outputText);
        visuals = VisualsSchema.parse(raw).visuals;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Model output failed schema validation: ${msg}` }],
        };
      }

      if (visuals.length !== chunks.length) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Model returned ${visuals.length} visuals for ${chunks.length} chunks; expected one-to-one`,
          }],
        };
      }

      const scenes: Scene[] = chunks.map((c, i) => ({
        start: c.start,
        end: c.end,
        visual: visuals[i].visual,
      }));

      const sidecar = {
        scenes,
        source_asset_id: sourceAssetId,
        total_duration_s: totalDuration,
        max_scene_seconds: CHUNK_S,
        characters,
        model: MODEL,
      };

      const markdown = renderMarkdown(sourceAssetId, totalDuration, characters, MODEL, scenes);

      const projectResult = await fs.getProject(project_slug);
      if (!projectResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: projectResult.error.message }],
        };
      }
      await mkdir(join(projectResult.value.path, "plan"), { recursive: true });

      const writeMd = await fs.writeFile("plan", "index.md", markdown, project_slug);
      if (!writeMd.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to write index.md: ${writeMd.error.message}` }],
        };
      }

      const writeJson = await fs.writeFile(
        "plan",
        ".plan.json",
        JSON.stringify(sidecar, null, 2),
        project_slug,
      );
      if (!writeJson.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to write .plan.json: ${writeJson.error.message}` }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id: "plan",
            scenes: scenes.length,
            total_duration_s: totalDuration,
            max_scene_seconds: CHUNK_S,
            model: MODEL,
            sampled_frames: sampled.length,
          }),
        }],
      };
    },
  };
}

export function registerPlanVisualizationTool(server: McpServer, fs: ClipfirstFs): void {
  const def = planVisualizationDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
