import { MODEL_ENTRIES } from "./catalog.js";
import { resolveModel } from "./descriptor.js";
import type { Media, ModeSpec, Operation, OptionSpec, ResolvedModel, SlotSpec } from "./types.js";

export interface ModelListing {
  id: string;
  title: string;
  provider: string;
  media: Media;
  operations: readonly Operation[];
  description?: string;
  prompt: { field: string; required: boolean } | null;
  refs: Array<Pick<SlotSpec, "role" | "min" | "max">>;
  modes: ModeSpec[];
  options: OptionSpec[];
  hidden: boolean;
}

export interface ListingFilter {
  media?: Media;
  operation?: Operation;
  includeHidden?: boolean;
}

export function modelListing(model: ResolvedModel): ModelListing {
  return {
    id: model.id,
    title: model.title,
    provider: model.provider,
    media: model.media,
    operations: model.entry.operations,
    ...(model.entry.description ? { description: model.entry.description } : {}),
    prompt: model.promptField ? { field: model.promptField, required: model.promptRequired } : null,
    refs: model.slots.map(({ role, min, max }) => ({ role, min, max })),
    modes: model.modes,
    options: model.options,
    hidden: model.entry.hidden === true,
  };
}

export function listModels(filter: ListingFilter = {}): ResolvedModel[] {
  return MODEL_ENTRIES
    .filter((entry) => filter.includeHidden || !entry.hidden)
    .filter((entry) => !filter.media || entry.media === filter.media)
    .filter((entry) => !filter.operation || entry.operations.includes(filter.operation))
    .map((entry) => resolveModel(entry.id));
}
