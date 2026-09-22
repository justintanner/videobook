import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import { cachedMusicAnalysis, musicSource, readMusicAnalysis } from "../rhythm/music-analysis.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function musicAnalysisDefs(engine: Engine): ToolDef[] {
  const schema = { book_id: z.string().uuid(), asset_id: z.string().uuid(), stream_id: z.string().uuid().optional() };
  return [
    {
      name: "analyze_music",
      description: "Analyze audio beats and waveform locally in a background job, reusing results for unchanged audio",
      scope: "book",
      schema: { ...schema, force: z.boolean().optional() },
      handler: async (args) => {
        try {
          const source = await musicSource(engine, String(args.asset_id), args.stream_id as string | undefined);
          if (!args.force && await cachedMusicAnalysis(engine, source)) return json(await readMusicAnalysis(engine, source.artifactId, source.streamId));
          await queue.enqueue(`music-${source.artifactId}-${source.analysisId}`, {
            type: "analyze_music", bookId: String(args.book_id), musicArtifactId: source.artifactId,
            analysisId: source.analysisId, streamId: source.streamId,
          });
          return json(await readMusicAnalysis(engine, source.artifactId, source.streamId));
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
        }
      },
    },
    {
      name: "get_music_analysis",
      description: "Read cached music beats, waveform and analysis job status for the current source audio",
      scope: "book", schema,
      handler: async (args) => {
        try {
          return json(await readMusicAnalysis(engine, String(args.asset_id), args.stream_id as string | undefined));
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
        }
      },
    },
  ];
}
