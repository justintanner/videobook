import type { Engine } from "videobook-engine";
import { z } from "zod";
import { aliveSource, cachedAliveAnalysis } from "../alive-captions/analyze.js";
import { readAliveSettings, writeAliveSettings } from "../alive-captions/model.js";
import type { AnalyzeAliveCaptionsResult } from "../jobs/analyze-alive-captions.js";
import { queue } from "../queue.js";
import { isValidHex } from "../remotion/util.js";
import type { AliveAnalysis, AliveSettings } from "../remotion/subtitles/alive-types.js";
import { ALIVE_MOTIONS, ALIVE_STYLES } from "../remotion/subtitles/alive-types.js";
import { artifactKindOf } from "./_shared.js";
import { RENDER_ORIENTATIONS } from "./reconcile-project-work.js";
import type { ToolDef } from "./tool-def.js";

const ANALYSIS_TIMEOUT_MS = 600_000;

function errorResult(status: string, message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ status, message }) }],
  };
}

function textResult(payload: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function videoGate(engine: Engine, assetId: string, tool: string) {
  const kind = artifactKindOf(engine, assetId);
  if (kind === null) return errorResult("asset_not_found", `Artifact ${assetId} was not found.`);
  if (kind !== "video") return errorResult("invalid_asset", `${tool} requires a video artifact; ${assetId} is ${kind}`);
  return null;
}

async function runAnalysis(engine: Engine, bookId: string, assetId: string, force: boolean): Promise<AliveAnalysis> {
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const clear = await engine.jobs.failures.clear(assetId);
  if (!clear.ok) throw new Error(clear.error.message);
  const result = await queue.enqueueAndWait<AnalyzeAliveCaptionsResult>(`alive-captions-${assetId}-${Date.now()}`, {
    type: "analyze_alive_captions",
    assetId,
    assetDir: manifest.value.path,
    bookId,
    force,
  }, ANALYSIS_TIMEOUT_MS);
  return result.analysis;
}

export function aliveCaptionsDef(engine: Engine): ToolDef {
  return {
    name: "alive_captions",
    description:
      "Read a video's alive-caption analysis (phrases, vocal onsets, per-word energy, loudness, face and text regions) and its saved caption settings, analyzing first when it is missing or stale.",
    schema: {
      asset_id: z.string().describe("Video artifact id"),
      book_id: z.string().describe("Book id"),
      reanalyze: z.boolean().optional().describe("Re-run the analysis even when the cached one is current (default false)"),
    },
    handler: async (args) => {
      const { asset_id, book_id, reanalyze = false } = args as { asset_id: string; book_id: string; reanalyze?: boolean };
      const gate = videoGate(engine, asset_id, "alive_captions");
      if (gate) return gate;
      let fingerprint: string;
      try {
        fingerprint = (await aliveSource(engine, asset_id)).fingerprint;
      } catch (error) {
        return errorResult("missing_transcript", error instanceof Error ? error.message : String(error));
      }
      const cached = reanalyze ? null : await cachedAliveAnalysis(engine, asset_id, fingerprint);
      let analysis = cached;
      if (!analysis) {
        try {
          analysis = await runAnalysis(engine, book_id, asset_id, reanalyze);
        } catch (error) {
          return errorResult("analysis_failed", error instanceof Error ? error.message : String(error));
        }
      }
      return textResult({
        asset_id,
        status: "ready",
        cached: cached !== null,
        regions_analyzed: analysis.regionsAnalyzed,
        settings: await readAliveSettings(engine, asset_id),
        analysis,
      });
    },
  };
}

interface SetAliveArgs {
  asset_id: string;
  book_id: string;
  style?: AliveSettings["style"];
  motion?: AliveSettings["motion"];
  energy_sizing?: boolean;
  snap_to_onsets?: boolean;
  avoid_faces?: boolean;
  avoid_text?: boolean;
  text_color?: string;
  hit_color?: string;
  apply_to_renders?: boolean;
}

function mergeSettings(current: AliveSettings, args: SetAliveArgs): AliveSettings {
  return {
    style: args.style ?? current.style,
    motion: args.motion ?? current.motion,
    energySizing: args.energy_sizing ?? current.energySizing,
    snapToOnsets: args.snap_to_onsets ?? current.snapToOnsets,
    avoidFaces: args.avoid_faces ?? current.avoidFaces,
    avoidText: args.avoid_text ?? current.avoidText,
    textColor: args.text_color ?? current.textColor,
    hitColor: args.hit_color ?? current.hitColor,
  };
}

function invalidColor(args: SetAliveArgs): string | null {
  if (args.text_color !== undefined && !isValidHex(args.text_color)) return `Invalid text_color hex: ${args.text_color}`;
  if (args.hit_color !== undefined && !isValidHex(args.hit_color)) return `Invalid hit_color hex: ${args.hit_color}`;
  return null;
}

/** Point every orientation's stored render settings at alive subtitles. */
async function applyToRenders(engine: Engine, assetId: string): Promise<void> {
  for (const orientation of RENDER_ORIENTATIONS) {
    const key = `${orientation}.render`;
    const existing = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, key);
    const write = await engine.metadata.artifacts.write(assetId, key, {
      ...(existing.ok ? existing.value : {}),
      subtitlesEnabled: true,
      highlightStyle: "alive",
    });
    if (!write.ok) throw new Error(`Failed to persist ${orientation} render settings: ${write.error.message}`);
  }
}

export function setAliveCaptionsDef(engine: Engine): ToolDef {
  return {
    name: "set_alive_captions",
    description:
      "Save a video's alive caption style (stack, punch or karaoke), word entrance (pop, slam or rise), energy sizing, onset snapping, face and text avoidance and colors; by default its renders switch to alive subtitles.",
    schema: {
      asset_id: z.string().describe("Video artifact id"),
      book_id: z.string().describe("Book id"),
      style: z.enum(ALIVE_STYLES as [AliveSettings["style"], ...AliveSettings["style"][]]).optional()
        .describe("stack builds a stacked block word by word; punch shows one big word at a time; karaoke shows the phrase dimmed and lights words"),
      motion: z.enum(ALIVE_MOTIONS as [AliveSettings["motion"], ...AliveSettings["motion"][]]).optional()
        .describe("Word entrance animation"),
      energy_sizing: z.boolean().optional().describe("Size lines by the vocal energy under each word"),
      snap_to_onsets: z.boolean().optional().describe("Start words on detected vocal onsets instead of raw transcript times"),
      avoid_faces: z.boolean().optional().describe("Keep captions off detected faces"),
      avoid_text: z.boolean().optional().describe("Keep captions off detected on-screen text and graphics"),
      text_color: z.string().optional().describe("Caption text color hex"),
      hit_color: z.string().optional().describe("Color for the sung word and loud words, hex"),
      apply_to_renders: z.boolean().optional().describe("Enable alive subtitles in stored render settings (default true)"),
    },
    handler: async (args) => {
      const input = args as unknown as SetAliveArgs;
      const gate = videoGate(engine, input.asset_id, "set_alive_captions");
      if (gate) return gate;
      const colorError = invalidColor(input);
      if (colorError) return errorResult("invalid_color", colorError);
      const settings = mergeSettings(await readAliveSettings(engine, input.asset_id), input);
      try {
        await writeAliveSettings(engine, input.asset_id, settings);
        if (input.apply_to_renders !== false) await applyToRenders(engine, input.asset_id);
      } catch (error) {
        return errorResult("settings_write_failed", error instanceof Error ? error.message : String(error));
      }
      return textResult({ asset_id: input.asset_id, status: "configured", settings, applied_to_renders: input.apply_to_renders !== false });
    },
  };
}
