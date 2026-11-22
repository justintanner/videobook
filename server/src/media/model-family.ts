import type { Media, ModelEntry } from "./types.js";

export interface ModelFamily {
  id: string;
  title: string;
}

export interface ModelFamilyFields {
  family: ModelFamily;
  variant?: string;
}

interface FamilySource {
  entry: Pick<ModelEntry, "family" | "variant">;
  media: Media;
  title: string;
}

const PROVIDER_SUFFIX = /\s*\((?:Kie|Fal|xAI|Alibaba|MachGen|WaveSpeed|Nunchux|OpenAI|Google|Google Flow)\)$/;

const OPERATION_SUFFIX = new RegExp(
  `\\s+(?:${[
    "Text to Image",
    "Image to Image",
    "Text to Video",
    "Image to Video",
    "Reference to Video",
    "Keyframes? to Video",
    "Video Edit",
    "Edit Video",
    "Edit",
    "Extend",
  ].map((words) => words.replaceAll(" ", "[ -]")).join("|")})$`,
  "i",
);

function familyTitle(title: string): string {
  return title.replace(PROVIDER_SUFFIX, "").replace(OPERATION_SUFFIX, "");
}

function familySlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function modelFamily(model: FamilySource): ModelFamilyFields {
  const title = model.entry.family ?? familyTitle(model.title);
  return {
    family: { id: `${model.media}:${familySlug(title)}`, title },
    ...(model.entry.variant ? { variant: model.entry.variant } : {}),
  };
}
