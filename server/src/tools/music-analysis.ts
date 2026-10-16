import type { Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import { cachedMusicAnalysis, musicSource, readMusicAnalysis, readSectionLabels, sectionLabelsCurrent, type MusicSource } from "../rhythm/music-analysis.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function musicAnalysisDefs(engine: Engine): ToolDef[] {
  const schema = { book_id: z.string().uuid(), asset_id: z.string().uuid(), stream_id: z.string().uuid().optional() };
  return [
    {
      name: "analyze_music",
      description: "Analyze an audio source's beats and waveform locally in a background job, reusing results for unchanged audio. sections adds an energy curve and suggested section boundaries and labels, which may use a paid model.",
      scope: "book",
      schema: { ...schema, force: z.boolean().optional(), sections: z.boolean().optional() },
      handler: async (args) => {
        try {
          const source = await musicSource(engine, String(args.asset_id), args.stream_id as string | undefined);
          if (!args.force && await cachedMusicAnalysis(engine, source)) {
            if (args.sections === true && !await labelsReadyOrPending(engine, source)) {
              await queue.enqueue(`music-sections-${source.artifactId}-${source.analysisId}`, {
                type: "label_music_sections", bookId: String(args.book_id), artifactId: source.artifactId,
                analysisId: source.analysisId, streamId: source.streamId,
              });
            }
            return json(await readMusicAnalysis(engine, source.artifactId, source.streamId));
          }
          await queue.enqueue(`music-${source.artifactId}-${source.analysisId}`, {
            type: "analyze_music", bookId: String(args.book_id), musicArtifactId: source.artifactId,
            analysisId: source.analysisId, streamId: source.streamId, sections: args.sections === true,
          });
          return json(await readMusicAnalysis(engine, source.artifactId, source.streamId));
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
        }
      },
    },
    {
      name: "get_music_analysis",
      description: "Read cached music beats, waveform, analysis job status and optional section energy/label suggestions for the current source audio",
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

async function labelsReadyOrPending(engine: Engine, source: MusicSource): Promise<boolean> {
  const analysis = await cachedMusicAnalysis(engine, source);
  const stored = analysis ? await readSectionLabels(engine, source.artifactId, source.analysisId) : null;
  if (stored && analysis && sectionLabelsCurrent(stored, analysis)) return true;
  const jobs = engine.jobs.queue.list({ type: "label_music_sections", limit: 500 });
  return jobs.some((item) => item.payload.analysisId === source.analysisId && ["queued", "running", "completing"].includes(item.state));
}
