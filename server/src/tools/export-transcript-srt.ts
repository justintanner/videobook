import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { z } from "zod";
import { copyToDownloads } from "../downloads-dest.js";
import {
  PLAIN_TRANSCRIPT_FILE,
  TIMED_TRANSCRIPT_FILE,
  timedTranscriptFrom,
} from "../transcript-projection.js";
import { transcriptToSrt } from "../transcript-srt.js";
import type { ToolDef } from "./tool-def.js";

function parseJson(value: Buffer | string): unknown {
  try {
    return JSON.parse(value.toString()) as unknown;
  } catch {
    return null;
  }
}

function errorResult(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

export function exportTranscriptSrtDef(engine: Engine): ToolDef {
  return {
    name: "export_transcript_srt",
    description:
      "Render an asset's word-timed ElevenLabs transcript as SubRip (.srt) and save it to the user's Downloads folder. Errors when the asset has no elevenlabs.json timings.",
    schema: {
      asset_id: z.string().describe("Artifact id"),
      book_id: z.string().describe("Book UUID"),
      downloads_dir: z.string().optional()
        .describe("Override Downloads directory (tests)"),
    },
    handler: async (args) => {
      const { asset_id, downloads_dir } = args as {
        asset_id: string;
        book_id: string;
        downloads_dir?: string;
      };

      const artifactResult = engine.artifacts.get(asset_id);
      if (!artifactResult.ok) {
        return errorResult(artifactResult.error.message);
      }

      const timedRead = await engine.files.read(asset_id, TIMED_TRANSCRIPT_FILE);
      if (!timedRead.ok) {
        const plainRead = await engine.files.read(asset_id, PLAIN_TRANSCRIPT_FILE);
        if (plainRead.ok) {
          return errorResult(
            "No word-timed ElevenLabs transcript for this asset. A plain gpt-4o transcription cannot be exported as SRT.",
          );
        }
        return errorResult(
          "No word-timed ElevenLabs transcript for this asset. Run /transcribe first.",
        );
      }
      const raw = parseJson(timedRead.value);
      const timed = timedTranscriptFrom(raw);
      if (!timed || timed.kind !== "timed") {
        return errorResult(
          "No word-timed ElevenLabs transcript for this asset. A plain gpt-4o transcription cannot be exported as SRT.",
        );
      }

      let srt: string;
      try {
        srt = transcriptToSrt({ words: timed.words });
      } catch (err) {
        return errorResult((err as Error).message);
      }

      const tempDir = await mkdtemp(join(tmpdir(), "videobook-srt-"));
      let dest: string;
      try {
        const tempPath = join(tempDir, "captions.srt");
        await writeFile(tempPath, srt, "utf8");
        dest = await copyToDownloads(tempPath, artifactResult.value.label ?? asset_id, ".srt", downloads_dir);
      } catch (err) {
        return errorResult(`Failed to save SRT: ${(err as Error).message}`);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ status: "exported", path: dest }),
        }],
      };
    },
  };
}
