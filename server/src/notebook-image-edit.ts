import { z } from "zod";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { findImageEditModel } from "./image-edit-models.js";
import { resolveImageRef } from "./tools/_media-refs.js";
import { previewPlaceholderUrl } from "./preview-payload.js";
import { previewImageSubjectEditRequest, type GenerateImageSubjectEditPayload } from "./jobs/image-subjects.js";

const boxSchema = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
}).refine((box) => box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001,
  { message: "Edit regions must fit inside the image" });

const editInputsSchema = z.object({
  generationMode: z.enum(["whole-image", "subject-edit", "subject-remove", "region-edit", "region-remove", "region-replace"]),
  sourceArtifactId: z.string().min(1),
  sourceObjectHash: z.string().min(1),
  subjectIds: z.array(z.string().min(1)).default([]),
  editRegions: z.array(boxSchema).optional(),
  regions: z.array(z.object({
    box: boxSchema.optional(), subjectId: z.string().optional(),
    replacementArtifactId: z.string().min(1), note: z.string().optional(),
  }).refine((region) => Boolean(region.box || region.subjectId))).optional(),
});

type EditJobInput = Pick<GenerateImageSubjectEditPayload,
  "sourceArtifactId" | "sourceObjectHash" | "subjectIds" | "operation" | "prompt"
  | "regions" | "editRegions" | "replacementRefs" | "modelId">;

export async function prepareNotebookImageEdit(
  engine: Engine,
  document: NotebookDocument,
  cell: NotebookCell,
  prompt: string,
): Promise<{
  jobInput: EditJobInput;
  input: Record<string, unknown>;
  provider: string;
  model: string;
  providerPayload: Record<string, unknown>;
}> {
  const inputs = editInputsSchema.parse(cell.inputs);
  const incoming = document.edges.filter((edge) => edge.target === cell.id);
  const source = incoming.length === 1 ? document.cells.find((candidate) => candidate.id === incoming[0]!.source) : null;
  if (!source || (source.outputArtifactId !== inputs.sourceArtifactId
    && !(Array.isArray(source.inputs?.outputVersionArtifactIds)
      && source.inputs.outputVersionArtifactIds.includes(inputs.sourceArtifactId)))) {
    throw new Error("This edit requires its original connected source image. Open the image editor to choose a different source.");
  }
  const mode = inputs.generationMode;
  const regional = mode === "region-edit" || mode === "region-remove";
  if (regional && !inputs.editRegions?.length) throw new Error("This edit has no saved regions");
  if (mode === "region-replace" && !inputs.regions?.length) throw new Error("This edit has no saved replacement regions");
  const local = mode === "subject-remove";
  const model = findImageEditModel(cell.model ?? "");
  if (!local && !model) throw new Error(`Unknown image edit model: ${cell.model}`);
  const replacementIds = mode === "region-replace"
    ? [...new Set(inputs.regions!.map((region) => region.replacementArtifactId))] : [];
  if (model?.maxInputImages !== null && model?.maxInputImages !== undefined
    && 1 + replacementIds.length > model.maxInputImages) {
    throw new Error(`${model.label} accepts at most ${model.maxInputImages} image inputs`);
  }
  const replacementRefs = [];
  for (const id of replacementIds) {
    const ref = await resolveImageRef(engine, id);
    if (!ref.ok) throw new Error(ref.error);
    replacementRefs.push(ref.value);
  }
  const jobInput: EditJobInput = {
    sourceArtifactId: inputs.sourceArtifactId,
    sourceObjectHash: inputs.sourceObjectHash,
    subjectIds: inputs.subjectIds,
    operation: mode === "whole-image" ? "whole_image"
      : mode === "region-replace" ? "replace"
        : mode.endsWith("remove") ? "remove" : "edit",
    prompt,
    ...(regional ? { editRegions: inputs.editRegions } : {}),
    ...(mode === "region-replace" ? { regions: inputs.regions, replacementRefs } : {}),
    ...(local ? {} : { modelId: model!.id }),
  };
  const refs = [inputs.sourceArtifactId, ...replacementIds];
  const request = await previewImageSubjectEditRequest(engine, jobInput, refs.map(previewPlaceholderUrl));
  const previewInput = Object.fromEntries(Object.entries(request.input).map(([key, value]) => [
    key, Array.isArray(value) && (key === "image_urls" || key === "input_urls")
      ? value.map((url) => {
          const id = refs.find((ref) => previewPlaceholderUrl(ref) === url);
          return id ? `@${id}` : url;
        }) : value,
  ]));
  const provider = local ? "local" : request.model === "grok-imagine-image-2-0/image-edit" ? "kie" : model!.provider;
  return {
    jobInput,
    input: { prompt, model: request.model, operation: jobInput.operation, image_refs: refs },
    provider,
    model: request.model,
    providerPayload: provider === "fal"
      ? { endpoint_id: request.model, input: previewInput }
      : { model: request.model, input: previewInput },
  };
}
