import type { AssetManifestFile, VideocityFs } from "videocity-engine";
import { findAudioFile, findVideoFile } from "videocity-engine";
import { extname } from "node:path";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

// Generation errors are not exclusive to generations: sidecar jobs (e.g. a
// failed ElevenLabs transcribe) write them onto completed assets too. Deleting
// is only safe for unmaterialized husks — an asset holding real media must be
// kept and merely have its error row cleared (the same clear the render tool
// performs before retrying).
function hasMediaFile(files: AssetManifestFile[], assetId: string): boolean {
  if (findVideoFile(files)) return true;
  if (findAudioFile(files, assetId)) return true;
  return files.some((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
}

export function clearFailedTasksDef(fs: VideocityFs): ToolDef {
  return {
    name: "clear_failed_tasks",
    description:
      "Clean up assets with a persisted generation error: delete unmaterialized generation husks (returned as 'cleared'), but keep assets that already hold media and only clear their error row (returned as 'error_cleared').",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };

      const failuresRes = await fs.generationErrors.findAll(project_slug);
      const failures = failuresRes.ok ? failuresRes.value : [];

      const cleared: string[] = [];
      const errorCleared: string[] = [];
      const errors: Array<{ assetId: string; message: string }> = [];

      for (const failure of failures) {
        const manifest = await fs.getManifest(failure.assetId, project_slug);
        const materialized =
          manifest.ok && hasMediaFile(manifest.value.files, failure.assetId);

        if (materialized) {
          const clearResult = await fs.generationErrors.clear(project_slug, failure.assetId);
          if (clearResult.ok) {
            errorCleared.push(failure.assetId);
          } else {
            errors.push({ assetId: failure.assetId, message: clearResult.error.message });
          }
          continue;
        }

        const result = await fs.deleteAsset(failure.assetId, project_slug);
        if (result.ok) {
          cleared.push(failure.assetId);
        } else {
          errors.push({ assetId: failure.assetId, message: result.error.message });
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ cleared, error_cleared: errorCleared, errors }),
        }],
      };
    },
  };
}
