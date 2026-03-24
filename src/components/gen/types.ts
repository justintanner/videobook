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
    image_slots?: { min: number; max: number } | null;
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
    image_slots?: { min: number; max: number } | null;
  };
}

export interface ResolvedAsset {
  slug: string;
  src: string;
  thumbnailSrc?: string | null;
  type: 'image' | 'video';
}

// Element group field pattern: element1_slugs, element2_name, element3_desc, etc.
export const ELEMENT_FIELD_RE = /^element(\d+)_(slugs|name|desc)$/;
export const MAX_ELEMENT_GROUPS = 3;

// Veo 3.1 generation modes
export type VeoGenerationType = 'TEXT_2_VIDEO' | 'FIRST_AND_LAST_FRAMES_2_VIDEO' | 'REFERENCE_2_VIDEO';

export interface VeoModeConstraint {
  image_slots: { min: number; max: number };
  allowed_aspect_ratios?: string[];
  requires_fast_model?: boolean;
}

export const VEO_MODE_CONSTRAINTS: Record<VeoGenerationType, VeoModeConstraint> = {
  TEXT_2_VIDEO: {
    image_slots: { min: 0, max: 0 },
  },
  FIRST_AND_LAST_FRAMES_2_VIDEO: {
    image_slots: { min: 1, max: 2 },
  },
  REFERENCE_2_VIDEO: {
    image_slots: { min: 1, max: 3 },
    allowed_aspect_ratios: ['16:9', '9:16'],
    requires_fast_model: true,
  },
};
