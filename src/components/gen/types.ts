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
  type: 'image' | 'video' | 'audio';
}

// Element group field pattern: element1_slugs, element2_name, element3_desc, etc.
export const ELEMENT_FIELD_RE = /^element(\d+)_(slugs|name|desc)$/;
export const MAX_ELEMENT_GROUPS = 3;

// Veo 3.1 generation modes
export type VeoGenerationType = 'TEXT_2_VIDEO' | 'FIRST_AND_LAST_FRAMES_2_VIDEO' | 'REFERENCE_2_VIDEO';
