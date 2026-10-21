import { resolveModel } from "./media/descriptor.js";
import type { ResolvedModel } from "./media/types.js";
import { DEFAULT_IMAGE_EDIT_MODEL_ID } from "./image-edit-default.js";
export { DEFAULT_IMAGE_EDIT_MODEL_ID } from "./image-edit-default.js";

export type ImageEditCapability = "semantic" | "regionReplace" | "wholeImage" | "exactMask";

export interface ImageEditModelInfo {
  /** Provider model/endpoint identifier; the subject-edit adapter id. */
  readonly id: string;
  /** Media catalog model id this edit runs on. */
  readonly catalogModel: string;
  readonly label: string;
  readonly provider: "kie" | "fal";
  readonly envKey: "KIE_API_KEY" | "FAL_API_KEY";
  /** Max image inputs from the catalog model's image slot; null = unbounded. */
  readonly maxInputImages: number | null;
  readonly capabilities: Readonly<Record<ImageEditCapability, boolean>>;
}

const STANDARD_IMAGE_EDIT_CAPABILITIES = {
  semantic: true,
  regionReplace: true,
  wholeImage: true,
  exactMask: false,
} as const;

const EDIT_MODELS: ReadonlyArray<{ catalogModel: string; label: string }> = [
  { catalogModel: `kie:${DEFAULT_IMAGE_EDIT_MODEL_ID}`, label: "Nano Banana 2.1 Edit" },
  { catalogModel: "kie:flux-3/klein-edit-image", label: "FLUX 3 Klein Edit" },
  { catalogModel: "kie:seedream/5-pro-image-to-image", label: "Seedream 5 Pro" },
  { catalogModel: "kie:gpt-image-2-5-flare-image-to-image", label: "GPT Image 2.5 Flare" },
  { catalogModel: "kie:gpt-image-2-5-sunburst-image-to-image", label: "GPT Image 2.5 Sunburst" },
  { catalogModel: "kie:gpt-image-2-image-to-image", label: "GPT Image 2" },
  { catalogModel: "fal:fal-ai/nano-banana-pro/edit", label: "Nano Banana Pro" },
  { catalogModel: "fal:fal-ai/nano-banana-2/edit", label: "Nano Banana 2" },
  { catalogModel: "fal:alibaba/qwen-image-3/edit", label: "Qwen 3.0 Edit" },
  { catalogModel: "fal:fal-ai/wan/v2.7/edit", label: "Wan 2.7 Edit" },
  { catalogModel: "fal:bria/fibo-2/edit", label: "Fibo 2 Edit" },
];

function imageSlotMax(model: ResolvedModel): number | null {
  return model.slots.find((slot) => slot.role === "image")?.max ?? null;
}

function editModelInfo(entry: { catalogModel: string; label: string }): ImageEditModelInfo {
  const model = resolveModel(entry.catalogModel);
  const provider = model.provider === "fal" ? "fal" : "kie";
  return {
    id: model.apiId,
    catalogModel: model.id,
    label: entry.label,
    provider,
    envKey: provider === "fal" ? "FAL_API_KEY" : "KIE_API_KEY",
    maxInputImages: imageSlotMax(model),
    capabilities: STANDARD_IMAGE_EDIT_CAPABILITIES,
  };
}

export const IMAGE_EDIT_MODELS: readonly ImageEditModelInfo[] = EDIT_MODELS.map(editModelInfo);

export const IMAGE_EDIT_MODEL_IDS = IMAGE_EDIT_MODELS.map((model) => model.id) as [string, ...string[]];

export function findImageEditModel(id: string): ImageEditModelInfo | undefined {
  return IMAGE_EDIT_MODELS.find((model) => model.id === id || model.catalogModel === id);
}
