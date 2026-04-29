import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { openai, withRetry, textPart, firstContent } from "@apicity/openai";
import type { OpenAiContentPart } from "@apicity/openai";
import type { ToolDef } from "./tool-def.js";
import {
  MODEL,
  decodeBuffer,
  type ElevenLabs,
  type ElevenLabsWord,
} from "./_suggest-shared.js";

const DEFAULT_MAX_SCENE_S = 15;
const COVERAGE_TOLERANCE_S = 0.05;

type CharacterContext = {
  asset_id: string;
  name: string;
  description: string;
};

type Scene = {
  index: number;
  start: number;
  end: number;
  title: string;
  transcript: string;
  speaker: string | null;
  visual: string;
};

type PlanResult = {
  scenes: Scene[];
  summary: string;
};

const SceneSchema = z.object({
  index: z.number().int().positive(),
  start: z.number().min(0),
  end: z.number().min(0),
  title: z.string().min(1),
  transcript: z.string(),
  speaker: z.string().nullable(),
  visual: z.string().min(1),
});

const PlanSchema = z.object({
  scenes: z.array(SceneSchema).min(1),
  summary: z.string().min(1),
});

const PLAN_JSON_SCHEMA = {
  type: "object",
  required: ["scenes", "summary"],
  additionalProperties: false,
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        required: ["index", "start", "end", "title", "transcript", "speaker", "visual"],
        additionalProperties: false,
        properties: {
          index: { type: "integer" },
          start: { type: "number" },
          end: { type: "number" },
          title: { type: "string" },
          transcript: { type: "string" },
          speaker: { type: ["string", "null"] },
          visual: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
  },
} as const;

function buildSystemPrompt(maxSceneSeconds: number): string {
  return `You are segmenting a transcribed video into a scene plan. You receive characters (up to 5), total duration in seconds, and a list of words with timestamps. Produce scenes that:

RULES:
1. Cover the entire transcript end-to-end with no gaps and no overlaps.
2. Each scene MUST be <= ${maxSceneSeconds}s (end - start). Hard cap; never exceed.
3. Break on natural speech boundaries: sentence ends, pauses >= 0.4s between words, or clear topic shifts. Prefer breaking on the longest pause within the window when forced to split.
4. Use the exact word start/end timestamps you are given. Do not invent times.
5. Adjacent scenes must touch: scenes[i].end === scenes[i+1].start.
6. The first scene's start equals the first word's start. The last scene's end equals the last word's end.
7. Reference characters by name in the "visual" field when the speech implies them. Use speaker_id from the words to set the "speaker" field for the dominant speaker in each scene; if undiarized or mixed, use null.
8. "title" is a short scannable label (3-7 words). "visual" is one sentence proposing a shot/visual concept for that scene.
9. "transcript" must be the exact words spoken within [start, end], joined with spaces.

Output JSON only, matching the provided schema.`;
}

function buildUserContext(
  totalDuration: number,
  maxSceneSeconds: number,
  characters: CharacterContext[],
  words: ElevenLabsWord[],
): string {
  const charBlock = characters.length === 0
    ? "Characters: none"
    : "Characters:\n" + characters.map((c) => `  - ${c.asset_id} | name: ${c.name} | ${c.description}`).join("\n");

  const wordLines = words
    .filter((w) => w.type === "word")
    .map((w) => {
      const speaker = w.speaker_id ?? "";
      return `${w.start.toFixed(2)}|${w.end.toFixed(2)}|${w.text}|${speaker}`;
    })
    .join("\n");

  return [
    `Total duration: ${totalDuration.toFixed(2)}s`,
    `Max scene length: ${maxSceneSeconds}s`,
    charBlock,
    "",
    "Words (start|end|text|speaker_id):",
    wordLines,
  ].join("\n");
}

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

function validateAndNormalize(
  parsed: PlanResult,
  words: ElevenLabsWord[],
  maxSceneSeconds: number,
): { ok: true; value: PlanResult } | { ok: false; error: string } {
  const scenes = parsed.scenes;
  if (scenes.length === 0) return { ok: false, error: "Model returned zero scenes" };

  const wordsOnly = words.filter((w) => w.type === "word");
  if (wordsOnly.length === 0) return { ok: false, error: "Transcript has no word entries" };
  const firstWordStart = wordsOnly[0].start;
  const lastWordEnd = wordsOnly[wordsOnly.length - 1].end;

  const sorted = [...scenes].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.end <= s.start) {
      return { ok: false, error: `Scene ${s.index}: end (${s.end}) must be > start (${s.start})` };
    }
    if (s.end - s.start > maxSceneSeconds + COVERAGE_TOLERANCE_S) {
      return {
        ok: false,
        error: `Scene ${s.index}: duration ${(s.end - s.start).toFixed(2)}s exceeds cap ${maxSceneSeconds}s`,
      };
    }
    if (i > 0) {
      const prev = sorted[i - 1];
      if (Math.abs(s.start - prev.end) > COVERAGE_TOLERANCE_S) {
        return {
          ok: false,
          error: `Scenes ${prev.index} and ${s.index} not contiguous: ${prev.end} -> ${s.start}`,
        };
      }
    }
  }

  if (sorted[0].start - firstWordStart > COVERAGE_TOLERANCE_S) {
    return { ok: false, error: `First scene starts at ${sorted[0].start}, after first word ${firstWordStart}` };
  }
  const lastSceneEnd = sorted[sorted.length - 1].end;
  if (lastWordEnd - lastSceneEnd > COVERAGE_TOLERANCE_S) {
    return { ok: false, error: `Last scene ends at ${lastSceneEnd}, before last word ${lastWordEnd}` };
  }

  const renumbered = sorted.map((s, i) => ({ ...s, index: i + 1 }));
  return { ok: true, value: { scenes: renumbered, summary: parsed.summary } };
}

function renderMarkdown(
  sourceAssetId: string,
  totalDuration: number,
  maxSceneSeconds: number,
  characters: CharacterContext[],
  model: string,
  plan: PlanResult,
): string {
  const charLine = characters.length === 0
    ? "none"
    : characters.map((c) => c.name).join(", ");

  const header = [
    "# Plan",
    "",
    `**Source:** ${sourceAssetId}`,
    `**Total duration:** ${totalDuration.toFixed(2)}s`,
    `**Scenes:** ${plan.scenes.length} (≤${maxSceneSeconds}s each)`,
    `**Characters:** ${charLine}`,
    `**Model:** ${model}`,
    "",
    `> ${plan.summary}`,
    "",
    "---",
    "",
  ].join("\n");

  const sceneBlocks = plan.scenes.map((s) => {
    const duration = (s.end - s.start).toFixed(2);
    const speakerLine = s.speaker ?? "—";
    return [
      `## Scene ${s.index} — ${s.title}`,
      "",
      `- **Time:** ${s.start.toFixed(2)}s – ${s.end.toFixed(2)}s (${duration}s)`,
      `- **Speaker:** ${speakerLine}`,
      `- **Transcript:** ${s.transcript}`,
      `- **Visual:** ${s.visual}`,
      "",
    ].join("\n");
  });

  return header + sceneBlocks.join("\n");
}

export function generatePlanDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_plan",
    description:
      "Generate a per-project scene plan from a video/audio asset's elevenlabs.json. " +
      "Each scene is capped at 15s (configurable). Optionally accepts up to 5 character assets for cast context. " +
      "Writes plan/index.md (human-readable) and plan/.plan.json (structured) into the project's singleton plan asset, overwriting any prior plan.",
    schema: {
      source_asset_id: z.string().describe("Asset ID with elevenlabs.json (vid-* or aud-*)"),
      project_slug: z.string().describe("Project slug"),
      character_asset_ids: z
        .array(z.string())
        .max(5)
        .optional()
        .describe("Up to 5 char-* assets to inform scene casting"),
      max_scene_seconds: z
        .number()
        .positive()
        .max(60)
        .optional()
        .describe(`Hard cap per scene (default ${DEFAULT_MAX_SCENE_S}s)`),
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
        max_scene_seconds,
      } = args as {
        source_asset_id: string;
        project_slug: string;
        character_asset_ids?: string[];
        max_scene_seconds?: number;
      };

      const sourceAssetId = source_asset_id.replace(/^@/, "");
      const maxSceneSeconds = max_scene_seconds ?? DEFAULT_MAX_SCENE_S;

      const projectResult = await fs.getProject(project_slug);
      if (!projectResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: projectResult.error.message }],
        };
      }
      const projectDir = projectResult.value.path;

      const manifestResult = await fs.getManifest(sourceAssetId, project_slug, { includeDotfiles: true });
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const elevenFile = manifestResult.value.files.find((f) => f.name === "elevenlabs.json");
      if (!elevenFile) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `No elevenlabs.json in asset ${sourceAssetId}. Run /transcribe first.`,
          }],
        };
      }

      const elevenRead = await fs.readFile(sourceAssetId, "elevenlabs.json", project_slug);
      if (!elevenRead.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: elevenRead.error.message }],
        };
      }

      let transcript: ElevenLabs;
      try {
        transcript = JSON.parse(decodeBuffer(elevenRead.value)) as ElevenLabs;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to parse elevenlabs.json: ${msg}` }],
        };
      }

      const wordsOnly = transcript.words.filter((w) => w.type === "word");
      if (wordsOnly.length === 0) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "elevenlabs.json contains no word entries" }],
        };
      }
      const totalDuration = wordsOnly[wordsOnly.length - 1].end;

      const characters: CharacterContext[] = [];
      for (const charId of character_asset_ids ?? []) {
        const ctx = await loadCharacter(fs, charId, project_slug);
        if (ctx) characters.push(ctx);
      }

      const userContent: OpenAiContentPart[] = [
        textPart(buildUserContext(totalDuration, maxSceneSeconds, characters, transcript.words)),
      ];

      const provider = openai({ apiKey, timeout: 240_000 });
      const call = withRetry(provider.post.v1.chat.completions, { retries: 2, baseMs: 500 });

      let outputText: string;
      try {
        const result = await call({
          model: MODEL,
          stream: false,
          messages: [
            { role: "system", content: buildSystemPrompt(maxSceneSeconds) },
            { role: "user", content: userContent },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "generate_plan_result",
              schema: PLAN_JSON_SCHEMA as unknown as Record<string, unknown>,
              strict: true,
            },
          },
          temperature: 0.3,
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

      let parsed: PlanResult;
      try {
        const raw = JSON.parse(outputText);
        parsed = PlanSchema.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Model output failed schema validation: ${msg}` }],
        };
      }

      const validated = validateAndNormalize(parsed, transcript.words, maxSceneSeconds);
      if (!validated.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Plan validation failed: ${validated.error}` }],
        };
      }

      const finalPlan: PlanResult & { source_asset_id: string; total_duration_s: number; max_scene_seconds: number; characters: CharacterContext[]; model: string } = {
        ...validated.value,
        source_asset_id: sourceAssetId,
        total_duration_s: totalDuration,
        max_scene_seconds: maxSceneSeconds,
        characters,
        model: MODEL,
      };

      const planDir = join(projectDir, "plan");
      await mkdir(planDir, { recursive: true });

      const markdown = renderMarkdown(
        sourceAssetId,
        totalDuration,
        maxSceneSeconds,
        characters,
        MODEL,
        validated.value,
      );

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
        JSON.stringify(finalPlan, null, 2),
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
            scenes: validated.value.scenes.length,
            total_duration_s: totalDuration,
            max_scene_seconds: maxSceneSeconds,
            model: MODEL,
          }),
        }],
      };
    },
  };
}

export function registerGeneratePlanTool(server: McpServer, fs: ClipfirstFs): void {
  const def = generatePlanDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
