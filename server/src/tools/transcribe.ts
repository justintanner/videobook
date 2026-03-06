import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { kie, type TaskResult } from "@nakedapi/kie";
import { queue, registerJobHandler } from "../queue.js";
import type { ToolDef } from "./tool-def.js";

const LOCK_DURATION_MS = 300_000;

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a"]);

function findAudioFile(files: AssetManifestFile[], assetId: string): AssetManifestFile | null {
  if (assetId.startsWith("vid-")) {
    return files.find((f) => f.name === "audio_original.mp3")
      ?? files.find((f) => f.name === "original.mp3")
      ?? null;
  }
  if (assetId.startsWith("aud-")) {
    return files.find((f) => {
      const ext = (f.extension ?? "").replace(/^\./, "").toLowerCase();
      return AUDIO_EXTENSIONS.has(ext);
    }) ?? null;
  }
  return null;
}

export function registerTranscribeJobHandler(): void {
  registerJobHandler("transcribe", async (payload) => {
    const { audioPath, audioFilename, tagAudioEvents, diarize, languageCode } = payload as {
      audioPath: string;
      audioFilename: string;
      tagAudioEvents: boolean;
      diarize: boolean;
      languageCode?: string;
    };

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) {
      throw new Error("KIE_API_KEY environment variable is not set");
    }

    const provider = kie({ apiKey, timeout: 60_000 });

    const audioBuffer = await readFile(audioPath);
    const blob = new Blob([audioBuffer]);

    const { downloadUrl } = await provider.uploadMedia({
      file: blob,
      filename: audioFilename,
    });

    const result: TaskResult = await provider.generate({
      model: "elevenlabs/speech-to-text",
      input: {
        audio_url: downloadUrl,
        tag_audio_events: tagAudioEvents,
        diarize,
        ...(languageCode ? { language_code: languageCode } : {}),
      },
    }, { timeoutMs: 300_000 });

    if (result.status === "failed") {
      throw new Error(`Transcription failed: ${result.error ?? "unknown error"}`);
    }

    if (!result.resultObject) {
      throw new Error("No transcription data in API response");
    }

    return { success: true, transcriptionJson: result.resultObject };
  });
}

export function transcribeDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "transcribe",
    description: "Transcribe audio from a video or audio asset using ElevenLabs speech-to-text. Writes elevenlabs.json into the asset directory.",
    schema: {
      asset_id: z.string().describe("Asset ID (vid-* or aud-*)"),
      project_slug: z.string().describe("Project slug"),
      language_code: z.string().optional().describe("Language code (e.g. 'en'). Auto-detected if omitted."),
      tag_audio_events: z.boolean().optional().default(true).describe("Tag audio events like laughter, music, etc."),
      diarize: z.boolean().optional().default(true).describe("Enable speaker diarization"),
    },
    handler: async (args) => {
      const { asset_id, project_slug, language_code, tag_audio_events, diarize } = args as {
        asset_id: string;
        project_slug: string;
        language_code?: string;
        tag_audio_events: boolean;
        diarize: boolean;
      };

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;
      const audioFile = findAudioFile(manifest.files, asset_id);
      if (!audioFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No audio file found in asset ${asset_id}` }],
        };
      }

      const audioPath = join(manifest.path, audioFile.name);
      const assetDir = manifest.path;

      const lockResult = await fs.acquireLock(assetDir, { durationMs: LOCK_DURATION_MS });
      if (!lockResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Asset is locked: ${lockResult.error.message}` }],
        };
      }

      try {
        const jobId = `transcribe-${asset_id}-${Date.now()}`;

        const jobResult = await queue.enqueueAndWait(jobId, {
          type: "transcribe",
          audioPath,
          audioFilename: audioFile.name,
          tagAudioEvents: tag_audio_events,
          diarize,
          ...(language_code ? { languageCode: language_code } : {}),
        } as unknown as Record<string, unknown>, { timeout: LOCK_DURATION_MS });

        const { transcriptionJson } = jobResult as unknown as { transcriptionJson: unknown };
        const transcriptionStr = JSON.stringify(transcriptionJson, null, 2);

        const writeResult = await fs.writeFile(asset_id, "elevenlabs.json", transcriptionStr, project_slug);
        if (!writeResult.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Failed to write transcription: ${writeResult.error.message}` }],
          };
        }

        await fs.commitOperation("transcribe", asset_id, { ...(language_code ? { language_code } : {}) }, project_slug);

        const detected = typeof transcriptionJson === "object" && transcriptionJson !== null && "language_code" in transcriptionJson
          ? (transcriptionJson as { language_code: string }).language_code
          : language_code ?? "auto";

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ asset_id, file: "elevenlabs.json", language_detected: detected }),
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Transcription failed: ${msg}` }],
        };
      } finally {
        await fs.releaseLock(assetDir);
      }
    },
  };
}

export function registerTranscribeTool(server: McpServer, fs: ClipfirstFs): void {
  registerTranscribeJobHandler();
  const def = transcribeDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
