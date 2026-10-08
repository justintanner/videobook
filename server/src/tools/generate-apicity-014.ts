import type { Engine } from "videobook-engine";
import { queue } from "../queue.js";
import type { ToolDef } from "./tool-def.js";
import { generationLabel } from "../artifact-label.js";
import { apicity014Action, apicity014Actions, apicity014ToolShape } from "../apicity-014-media.js";

function toolError(text: string): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text }] };
}

export function generateApicity014Defs(engine: Engine): ToolDef[] {
  return apicity014Actions().map((listed) => {
    const action = apicity014Action(listed.canonicalName);
    const schema = apicity014ToolShape(listed.canonicalName);
    if (!action || !schema) {
      throw new Error(`Missing apicity 0.14.1 tool surface for ${listed.canonicalName}`);
    }
    const envKey = action.provider === "fal" ? "FAL_API_KEY" : "KIE_API_KEY";
    const artifactKind = action.mediaType === "video" ? "vid" : "img";
    return {
      name: action.canonicalName,
      description: action.description,
      schema,
      handler: async (args) => {
        if (!process.env[envKey]) return toolError(`${envKey} environment variable is not set`);
        const bookId = args.book_id;
        if (typeof bookId !== "string" || bookId.length === 0) return toolError("book_id is required");
        const prompt = typeof args.prompt === "string" ? args.prompt : undefined;
        const assetResult = await engine.artifacts.create(artifactKind, generationLabel(action.provenanceModel, prompt));
        if (!assetResult.ok) return toolError(`Failed to create ${artifactKind} asset: ${assetResult.error.message}`);
        const { artifactId, path: assetDir } = assetResult.value;
        const jobId = `${action.provider}-${artifactId}-${Date.now()}`;
        await queue.enqueue(jobId, {
          type: action.jobType,
          toolName: action.canonicalName,
          bookId,
          assetId: artifactId,
          assetDir,
          args,
        });
        const idKey = artifactKind === "vid" ? "vid_asset_id" : "img_asset_id";
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ [idKey]: artifactId, job_id: jobId, status: "enqueued" }),
          }],
        };
      },
    };
  });
}
