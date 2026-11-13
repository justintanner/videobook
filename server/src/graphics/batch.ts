import { createHash } from "node:crypto";
import type { Engine } from "videobook-engine";
import { withNotebookMutation } from "../notebook-mutations.js";
import { renderRequestFingerprint, renderRequestStatus, writeRenderSetting, type RenderRequestStatus } from "../render-requests.js";
import { resolveVideoAssetReference } from "../tools/video-source-reference.js";
import { GraphicsServiceError } from "./errors.js";
import { readGraphicsRenderRequest, requestGraphicsRender, requireGraphicsImages, requireSettledVideo } from "./render.js";
import { readGraphics, updateGraphics, type GraphicsLook } from "./service.js";

interface BatchInput {
  assetIds: string[];
  templateId: string;
  requestId: string;
  render: boolean;
  notebookId: string | null;
  look: GraphicsLook;
}

interface AppliedTemplate {
  asset_id: string;
  address: string | null;
  label: string | null;
  revision: string;
  sourceHash: string;
}

type BatchResult = Omit<AppliedTemplate, "sourceHash"> & { status: "applied" | "rendering"; render?: RenderRequestStatus }
  | { asset_id: string; status: "error"; error: { code: string; message: string } };

function renderId(batchId: string, assetId: string): string {
  const hex = createHash("sha256").update(JSON.stringify([batchId, assetId])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function applyOne(engine: Engine, assetId: string, input: BatchInput): Promise<AppliedTemplate> {
  await requireSettledVideo(engine, assetId);
  const read = await readGraphics(engine, assetId, { notebookId: input.notebookId, look: input.look });
  const template = [...read.templates, ...read.starters].find((entry) => entry.id === input.templateId);
  if (!template) throw new GraphicsServiceError("not_found", "This graphics template no longer exists.");
  await requireGraphicsImages(engine, template.document.layers.filter((layer) => layer.kind === "image"));
  const draft = await updateGraphics(engine, assetId, {
    expectedRevision: read.revision, look: input.look,
    edits: [{ op: "apply_template", template: template.document }],
  });
  return { asset_id: assetId, address: read.address, label: read.label, revision: draft.revision, sourceHash: read.source.source_hash };
}

async function batchVideo(engine: Engine, bookId: string, assetId: string, input: BatchInput): Promise<BatchResult> {
  const requestId = renderId(input.requestId, assetId);
  const key = `graphics.batch.applied.${requestId}`;
  const applied = engine.settings.get<AppliedTemplate>(key) ?? await applyOne(engine, assetId, input);
  writeRenderSetting(engine, key, applied);
  const { sourceHash, ...result } = applied;
  if (!input.render) return { ...result, status: "applied" };
  const existing = readGraphicsRenderRequest(engine, requestId);
  const render = existing ? renderRequestStatus(engine, existing) : await requestGraphicsRender(engine, bookId, assetId, {
    requestId, expectedRevision: applied.revision, sourceHash,
    notebookId: input.notebookId, output: "new", look: input.look,
  });
  return { ...result, status: "rendering", render };
}

export async function applyGraphicsTemplateBatch(engine: Engine, bookId: string, input: BatchInput) {
  return withNotebookMutation(`graphics-batch:${bookId}:${input.requestId}`, async () => {
    const key = `graphics.batch.${input.requestId}`;
    const fingerprint = renderRequestFingerprint([input.assetIds, input.templateId, input.render, input.notebookId, input.look]);
    const existing = engine.settings.get<string>(key);
    if (existing && existing !== fingerprint) throw new GraphicsServiceError("invalid", "This request ID belongs to a different template batch. Start a new request.");
    writeRenderSetting(engine, key, fingerprint);
    const results: BatchResult[] = [];
    for (const reference of input.assetIds) {
      let assetId = reference;
      try {
        assetId = resolveVideoAssetReference(engine, reference, input.notebookId ?? undefined);
        results.push(await batchVideo(engine, bookId, assetId, input));
      } catch (error) {
        results.push({ asset_id: assetId, status: "error", error: {
          code: error instanceof GraphicsServiceError ? error.code : "error",
          message: error instanceof Error ? error.message : String(error),
        } });
      }
    }
    return { request_id: input.requestId, results };
  });
}
