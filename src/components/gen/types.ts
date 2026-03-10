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
}

export type ExecuteButtonState = 'disabled' | 'ready' | 'charging' | 'submitting' | 'queued' | 'processing' | 'success';
