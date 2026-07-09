export interface JSONSchemaProperty {
  type: 'string' | 'array' | 'integer' | 'number' | 'boolean';
  description?: string;
  enum?: string[] | number[];
  default?: unknown;
  items?: { type: string; properties?: Record<string, JSONSchemaProperty>; required?: string[] };
  minimum?: number;
  maximum?: number;
  maxItems?: number;
}

export interface JSONSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  defaults?: Record<string, unknown>;
}

export interface SlotConstraints {
  min: number;
  max: number | null;
}

// Generation modes — client mirror of the server contract in video-models.ts.
// A model that ships `modes` renders as mutually-exclusive tabs; each tab shows
// only its own params plus the shared params. Options without `modes` render as
// a flat form exactly as before.
export type ModeAssetSlotKind = 'image' | 'video' | 'audio';

export interface ModeAssetSlot {
  param: string;
  kind: ModeAssetSlotKind;
  label: string;
  min?: number;
  max?: number | null;
}

export interface ModeSpec {
  key: string;
  label: string;
  description?: string;
  /** Mode-owned params (beyond the shared set). Only these drive inference. */
  params: string[];
  /** Shared params suppressed in this mode (e.g. duration in a V2V edit). */
  hidden_shared_params?: string[];
  required?: string[];
  asset_slots?: ModeAssetSlot[];
  param_overrides?: Record<string, { maxItems?: number; description?: string }>;
  /** Reserved for tool-per-mode models; unset today. Submit resolves
   *  `mode.tool_name ?? option.tool_name`. */
  tool_name?: string;
}

export interface ModelModes {
  shared_params: string[];
  default_mode: string;
  modes: ModeSpec[];
}

export interface ModelOption {
  key: string;
  label: string;
  tool_name: string;
  description: string;
  schema: JSONSchema;
  prefilled_values: Record<string, unknown>;
  validation: {
    valid: boolean;
    missing_required: string[];
    warnings: string[];
    image_slots?: SlotConstraints | null;
  };
  providers?: Array<{ key: string; label: string }>;
  selected_provider?: string;
  modes?: ModelModes | null;
}

export interface DynamicGenerationPreview {
  category: 'image' | 'video' | 'audio';
  selected_model: string;
  selected_provider?: string;
  model_options: ModelOption[];
  resolved_assets?: ResolvedAsset[];
}

export interface FullPreviewResponse extends DynamicGenerationPreview {
  tool_name: string;
  tool_description: string;
  schema: JSONSchema;
  prefilled_values: Record<string, unknown>;
  validation: {
    valid: boolean;
    missing_required: string[];
    warnings: string[];
    image_slots?: SlotConstraints | null;
  };
}

export interface ResolvedAsset {
  slug: string;
  src: string;
  thumbnailSrc?: string | null;
  type: 'image' | 'video' | 'audio' | 'character';
}

// Element group field pattern: element1_slugs, element2_name, element3_desc, etc.
export const ELEMENT_FIELD_RE = /^element(\d+)_(slugs|name|desc)$/;
export const MAX_ELEMENT_GROUPS = 3;
