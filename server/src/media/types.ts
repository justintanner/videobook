import type { ZodObject, ZodRawShape, ZodType } from "zod";

export type ProviderId = "kie" | "fal" | "xai" | "alibaba" | "elevenlabs" | "machgen";

export type Media = "image" | "video" | "audio";

export type Operation =
  | "text_to_image"
  | "edit_image"
  | "layer_image"
  | "text_to_video"
  | "image_to_video"
  | "reference_to_video"
  | "edit_video"
  | "extend_video"
  | "upscale_video"
  | "lip_sync"
  | "motion_control"
  | "speech"
  | "dialogue"
  | "music"
  | "sfx"
  | "video_to_music";

export const OPERATIONS_BY_MEDIA = {
  image: ["text_to_image", "edit_image", "layer_image"],
  video: ["text_to_video", "image_to_video", "reference_to_video", "edit_video", "extend_video", "upscale_video", "lip_sync", "motion_control"],
  audio: ["speech", "dialogue", "music", "sfx", "video_to_music"],
} as const satisfies Record<Media, readonly [Operation, ...Operation[]]>;

export type RefRole = "image" | "video" | "audio" | "first_frame" | "last_frame";

export const REF_ROLES: readonly RefRole[] = ["first_frame", "last_frame", "image", "video", "audio"];

export type PromptDialect =
  | "plain"
  | "natural"
  | "natural_numbered"
  | "natural_kinds"
  | "natural_source_video"
  | "natural_strip_frames"
  | "seedance"
  | "strip_frames"
  | "brackets"
  | "vidu"
  | "kling4"
  | "kling4_keyframes"
  | "happyhorse_edit";

export type PromptGuide =
  | "nano_banana"
  | "gpt_image"
  | "kling30"
  | "grok_imagine"
  | "grok_image"
  | "seedance2"
  | "seedance25";

export interface ModeSpec {
  id: string;
  label: string;
  roles: readonly RefRole[];
  requireAny?: readonly RefRole[];
  defaults?: Record<string, unknown>;
}

export interface RefDurationWindowMs {
  minimum: number;
  maximum: number;
  maximumTotal: number;
}

export interface InputRules {
  maxPromptChars?: number;
  refDurationMs?: Partial<Record<"video" | "audio", RefDurationWindowMs>>;
}

export interface ModelEntry {
  id: string;
  media: Media;
  operations: readonly Operation[];
  title?: string;
  description?: string;
  prompt?: string | null;
  refs?: Partial<Record<RefRole, string | readonly string[] | null>>;
  aliases?: Record<string, string>;
  defaults?: Record<string, unknown>;
  pinnedDefaults?: readonly string[];
  keyframeFps?: number;
  refItem?: Partial<Record<RefRole, Record<string, unknown>>>;
  dialect?: PromptDialect;
  guide?: PromptGuide;
  modes?: readonly ModeSpec[];
  frameOptions?: Record<string, unknown>;
  rules?: InputRules;
  hidden?: boolean;
}

export interface ParsedModelId {
  id: string;
  provider: ProviderId;
  apiId: string;
}

export interface WireSpec {
  input: ZodObject<ZodRawShape>;
  fixed: Record<string, unknown>;
  wrap: (input: Record<string, unknown>) => Record<string, unknown>;
  request: ZodType;
}

export interface SlotField {
  path: string;
  multi: boolean;
  max: number | null;
  urlObject: boolean;
  keyframe?: boolean;
}

export interface SlotSpec {
  role: RefRole;
  field: string;
  fields: SlotField[];
  multi: boolean;
  min: number;
  max: number | null;
}

export type OptionValueType = "string" | "number" | "integer" | "boolean" | "json";

export interface OptionSpec {
  name: string;
  path: string;
  valueType: OptionValueType;
  required: boolean;
  enumValues: Array<string | number>;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  defaultValue?: unknown;
  description: string;
}

export interface ResolvedModel {
  entry: ModelEntry;
  id: string;
  provider: ProviderId;
  apiId: string;
  media: Media;
  title: string;
  wire: WireSpec;
  promptField: string | null;
  promptRequired: boolean;
  slots: SlotSpec[];
  options: OptionSpec[];
  modes: ModeSpec[];
}

export type MediaRefs = Partial<Record<RefRole, string[]>>;
