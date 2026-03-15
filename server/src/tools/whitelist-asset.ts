import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { queue } from "../queue.js";
import { findAudioFile } from "../media-files.js";
import { readAndAssessDialog } from "../dialog-quality.js";
import type { ToolDef } from "./tool-def.js";

export const WHITELISTED_AT_FILE = ".whitelisted_at";

export function whitelistDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "whitelist",
    description:
      "Whitelist a video asset for transcription. Videos must be whitelisted before they can be transcribed. New videos start as unreviewed — use this to mark them as ready for the transcription pipeline.",
    schema: {
      asset_id: z.string().describe("Video asset ID (e.g. vid-cute-cat)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as {
        asset_id: string;
        project_slug: string;
      };

      if (!asset_id.startsWith("vid-")) {
        return {
          isError: true as const,
          content: [
            {
              type: "text" as const,
              text: "Only video assets (vid-*) can be whitelisted",
            },
          ],
        };
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug, { includeDotfiles: true });
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [
            { type: "text" as const, text: manifestResult.error.message },
          ],
        };
      }

      const alreadyWhitelisted = manifestResult.value.files.some(
        (f) => f.name === WHITELISTED_AT_FILE,
      );

      const timestamp = String(Date.now() / 1000);
      const writeResult = await fs.writeFile(
        asset_id,
        WHITELISTED_AT_FILE,
        timestamp,
        project_slug,
      );
      if (!writeResult.ok) {
        return {
          isError: true as const,
          content: [
            { type: "text" as const, text: writeResult.error.message },
          ],
        };
      }

      const status = alreadyWhitelisted ? "already_whitelisted" : "whitelisted";

      // Pipeline trigger: assess dialog and enqueue transcription if appropriate
      const manifest = manifestResult.value;
      const fileNames = new Set(manifest.files.map((f) => f.name));

      if (fileNames.has(".kie-task.json")) {
        return ok({ asset_id, status, whitelisted_at: timestamp, transcription: "skipped_in_progress" });
      }
      if (!fileNames.has(".original.analysis.json")) {
        return ok({ asset_id, status, whitelisted_at: timestamp, transcription: "pipeline_pending" });
      }

      const dialogQuality = await readAndAssessDialog(fs, asset_id, project_slug);

      if (!dialogQuality.hasDialog) {
        return ok({ asset_id, status, whitelisted_at: timestamp, transcription: "skipped", dialog_quality: dialogQuality });
      }

      if (!process.env.KIE_API_KEY) {
        return ok({ asset_id, status, whitelisted_at: timestamp, transcription: "skipped_no_api_key", dialog_quality: dialogQuality });
      }

      const audioFile = findAudioFile(manifest.files, asset_id);
      if (!audioFile) {
        return ok({ asset_id, status, whitelisted_at: timestamp, transcription: "skipped_no_audio", dialog_quality: dialogQuality });
      }

      const jobId = `auto-transcribe-${asset_id}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "transcribe",
        audioPath: join(manifest.path, audioFile.name),
        audioFilename: audioFile.name,
        tagAudioEvents: true,
        diarize: true,
        assetId: asset_id,
        assetDir: manifest.path,
        projectSlug: project_slug,
        autoRender: true,
      } as unknown as Record<string, unknown>);

      return ok({ asset_id, status, whitelisted_at: timestamp, transcription: "enqueued", job_id: jobId, dialog_quality: dialogQuality });
    },
  };
}

function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

export function registerWhitelistTool(
  server: McpServer,
  fs: ClipfirstFs,
): void {
  const def = whitelistDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
