import type { ArtifactManifestFile, Engine } from "videobook-engine";
import { findAudioFile, findVideoFile } from "videobook-engine";
import { extname } from "node:path";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

// Generation errors are not exclusive to generations: sidecar jobs (e.g. a
// failed ElevenLabs transcribe) write them onto completed assets too. Deleting
// is only safe for unmaterialized husks — an asset holding real media must be
// kept and merely have its error row cleared (the same clear the render tool
// performs before retrying).
function hasMediaFile(files: ArtifactManifestFile[], assetId: string): boolean {
  if (findVideoFile(files)) return true;
  if (findAudioFile(files, assetId)) return true;
  return files.some((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
}

export function clearFailedTasksDef(fs: Engine): ToolDef {
  return {
    name: "clean_failed_assets",
    description:
      "Clean up assets with a persisted generation error: delete unmaterialized generation husks (returned as 'cleared'), but keep assets that already hold media and only clear their error row (returned as 'error_cleared').",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };

      const failuresRes = await fs.jobs.failures.findAll(project_slug);
      const failures = failuresRes.ok ? failuresRes.value : [];

      const cleared: string[] = [];
      const errorCleared: string[] = [];
      const errors: Array<{ assetId: string; message: string }> = [];

      for (const failure of failures) {
        const manifest = await fs.files.manifest(failure.artifactSlug, project_slug);
        const materialized =
          manifest.ok && hasMediaFile(manifest.value.files, failure.artifactSlug);

        if (materialized) {
          const clearResult = await fs.jobs.failures.clear(project_slug, failure.artifactSlug);
          if (clearResult.ok) {
            errorCleared.push(failure.artifactSlug);
          } else {
            errors.push({ assetId: failure.artifactSlug, message: clearResult.error.message });
          }
          continue;
        }

        const result = await fs.artifacts.delete(failure.artifactSlug, project_slug);
        if (result.ok) {
          cleared.push(failure.artifactSlug);
        } else {
          errors.push({ assetId: failure.artifactSlug, message: result.error.message });
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
