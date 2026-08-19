import type { ArtifactKind, ArtifactManifestFile, Engine } from "videobook-engine";
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
function hasMediaFile(files: ArtifactManifestFile[], kind: ArtifactKind): boolean {
  if (findVideoFile(files)) return true;
  if (findAudioFile(files, kind)) return true;
  return files.some((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
}

export function clearFailedTasksDef(engine: Engine): ToolDef {
  return {
    name: "clean_failed_assets",
    description:
      "Clean up assets with a persisted generation error: delete unmaterialized generation husks (returned as 'cleared'), but keep assets that already hold media and only clear their error row (returned as 'error_cleared').",
    schema: {
      book_id: z.string().describe("Book id"),
    },
    handler: async (args) => {
      const { book_id: _book_id } = args as { book_id: string };

      const failuresRes = await engine.jobs.failures.findAll();
      const failures = failuresRes.ok ? failuresRes.value : [];

      const cleared: string[] = [];
      const errorCleared: string[] = [];
      const errors: Array<{ assetId: string; message: string }> = [];

      for (const failure of failures) {
        const artifact = engine.artifacts.get(failure.artifactId);
        const manifest = await engine.files.manifest(failure.artifactId);
        const materialized =
          artifact.ok
          && manifest.ok
          && hasMediaFile(manifest.value.files, artifact.value.kind);

        if (materialized) {
          const clearResult = await engine.jobs.failures.clear(failure.artifactId);
          if (clearResult.ok) {
            errorCleared.push(failure.artifactId);
          } else {
            errors.push({ assetId: failure.artifactId, message: clearResult.error.message });
          }
          continue;
        }

        const result = await engine.artifacts.delete(failure.artifactId);
        if (result.ok) {
          cleared.push(failure.artifactId);
        } else {
          errors.push({ assetId: failure.artifactId, message: result.error.message });
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
