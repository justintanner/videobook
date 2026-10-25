import type { ModelEntry, OptionSpec } from "./types.js";

const PREFERRED_DURATION_SECONDS = 12;
const PREFERRED_ASPECT_RATIO = "9:16";
const PREFERRED_IMAGE_SIZE_PRESET = "portrait_16_9";
const IMAGE_SIZE_PRESETS = new Set(["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"]);

export type StickySettingGroup = "duration" | "aspect" | "resolution" | "quality" | "bitrate";

type SettingValue = string | number | boolean;

const GROUP_FIELDS: Readonly<Record<StickySettingGroup, readonly string[]>> = {
  duration: ["duration"],
  aspect: ["aspect_ratio", "aspectRatio", "image_size"],
  resolution: ["resolution", "output_resolution", "size", "mode"],
  quality: ["quality"],
  bitrate: ["bitrate_mode"],
};

const QUALITY_RANK: readonly string[] = ["very_low", "low", "basic", "standard", "medium", "high"];

const UNTIMED_VIDEO_OPERATIONS = new Set(["edit_video", "lip_sync", "upscale_video", "motion_control"]);

export function stickySettingGroup(name: string): StickySettingGroup | null {
  const entry = Object.entries(GROUP_FIELDS).find(([, fields]) => fields.includes(name));
  return entry ? entry[0] as StickySettingGroup : null;
}

function resolutionRank(value: string | number): number | null {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)\s*(p|k|sq)?$/iu.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  return match[2]?.toLowerCase() === "k" ? amount * 1000 : amount;
}

function isResolutionEnum(values: readonly (string | number)[]): boolean {
  return values.length > 0 && values.every((value) => resolutionRank(value) !== null);
}

function highestBy(values: readonly (string | number)[], rank: (value: string | number) => number | null): string | number | undefined {
  const ranked = values.flatMap((value) => {
    const score = rank(value);
    return score === null ? [] : [{ value, score }];
  });
  if (ranked.length === 0) return undefined;
  return ranked.reduce((best, candidate) => candidate.score > best.score ? candidate : best).value;
}

function qualityRank(value: string | number): number | null {
  const index = QUALITY_RANK.indexOf(String(value).toLowerCase());
  return index < 0 ? null : index;
}

function isNumeric(option: OptionSpec): boolean {
  return option.valueType === "number" || option.valueType === "integer" || option.valueType === "json";
}

function clampToBounds(option: OptionSpec, value: number): number {
  const low = option.minimum ?? Number.NEGATIVE_INFINITY;
  const high = option.maximum ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(value, low), high);
}

function nearestDurationChoice(values: readonly (string | number)[], target: number): string | number | undefined {
  const numeric = values.filter((value) => Number.isFinite(Number(value)));
  if (numeric.length === 0) return undefined;
  const atOrBelow = numeric.filter((value) => Number(value) <= target);
  const pool = atOrBelow.length > 0 ? atOrBelow : numeric;
  return pool.reduce((best, candidate) =>
    Math.abs(Number(candidate) - target) < Math.abs(Number(best) - target) ? candidate : best);
}

function preferredDuration(option: OptionSpec): string | number | undefined {
  if (option.enumValues.length > 0) return nearestDurationChoice(option.enumValues, PREFERRED_DURATION_SECONDS);
  if (!isNumeric(option)) return undefined;
  return clampToBounds(option, PREFERRED_DURATION_SECONDS);
}

function takesImageSizePreset(entry: ModelEntry, option: OptionSpec): boolean {
  if (option.name !== "image_size" || option.valueType !== "json" || !entry.id.startsWith("fal:")) return false;
  if (!entry.operations.includes("text_to_image")) return false;
  return option.defaultValue === undefined || IMAGE_SIZE_PRESETS.has(String(option.defaultValue));
}

function preferredAspect(entry: ModelEntry, option: OptionSpec): string | undefined {
  if (option.enumValues.includes(PREFERRED_ASPECT_RATIO)) return PREFERRED_ASPECT_RATIO;
  return takesImageSizePreset(entry, option) ? PREFERRED_IMAGE_SIZE_PRESET : undefined;
}

function preferredResolution(option: OptionSpec): string | number | undefined {
  if (!isResolutionEnum(option.enumValues.filter((value) => value !== "auto"))) return undefined;
  return highestBy(option.enumValues, resolutionRank);
}

function preferredQuality(option: OptionSpec): string | number | undefined {
  return highestBy(option.enumValues, qualityRank);
}

export function takesDuration(entry: ModelEntry): boolean {
  return entry.media === "video" && entry.operations.some((operation) => !UNTIMED_VIDEO_OPERATIONS.has(operation));
}

function preferredValue(entry: ModelEntry, option: OptionSpec): string | number | undefined {
  if (option.name !== option.path || entry.pinnedDefaults?.includes(option.name)) return undefined;
  const group = stickySettingGroup(option.name);
  if (group === "duration") return takesDuration(entry) ? preferredDuration(option) : undefined;
  if (group === "aspect") return preferredAspect(entry, option);
  if (group === "resolution") return preferredResolution(option);
  if (group === "quality" || group === "bitrate") return preferredQuality(option);
  return undefined;
}

export function preferredDefaults(entry: ModelEntry, options: readonly OptionSpec[]): Record<string, unknown> {
  if (entry.media !== "video" && entry.media !== "image") return {};
  return Object.fromEntries(options.flatMap((option) => {
    const value = preferredValue(entry, option);
    return value === undefined ? [] : [[option.name, value]];
  }));
}

function sameResolution(left: string | number, right: string | number): boolean {
  const a = resolutionRank(left);
  const b = resolutionRank(right);
  return a !== null && a === b && String(left).toLowerCase().replace(/p$/u, "") === String(right).toLowerCase().replace(/p$/u, "");
}

function matchingChoice(choices: readonly SettingValue[], value: SettingValue): SettingValue | undefined {
  return choices.find((choice) => choice === value)
    ?? choices.find((choice) => String(choice).toLowerCase() === String(value).toLowerCase())
    ?? choices.find((choice) => typeof choice !== "boolean" && typeof value !== "boolean" && sameResolution(choice, value));
}

export type StickyControl = {
  name: string;
  valueType: "string" | "number" | "boolean";
  options: readonly SettingValue[];
  minimum?: number;
  maximum?: number;
};

function acceptedStickyValue(control: StickyControl, value: SettingValue): SettingValue | undefined {
  if (control.options.length > 0) return matchingChoice(control.options, value);
  if (control.valueType !== "number") return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  if (control.minimum !== undefined && numeric < control.minimum) return undefined;
  if (control.maximum !== undefined && numeric > control.maximum) return undefined;
  return numeric;
}

export type StickySettings = Partial<Record<StickySettingGroup, SettingValue>>;

function isStickyValue(group: StickySettingGroup, value: unknown): value is SettingValue {
  if (typeof value !== "string" && typeof value !== "number") return false;
  return group !== "resolution" || resolutionRank(value) !== null;
}

export function stickySettingsFrom(settings: Readonly<Record<string, unknown>>): StickySettings {
  return Object.fromEntries(Object.entries(settings).flatMap(([name, value]) => {
    const group = stickySettingGroup(name);
    if (!group || !isStickyValue(group, value)) return [];
    return [[group, value]];
  }));
}

function isStickySettingGroup(name: string): name is StickySettingGroup {
  return Object.hasOwn(GROUP_FIELDS, name);
}

export function parseStickySettings(stored: Readonly<Record<string, unknown>>): StickySettings {
  return Object.fromEntries(Object.entries(stored).flatMap(([group, value]) =>
    isStickySettingGroup(group) && isStickyValue(group, value) ? [[group, value]] : []));
}

export function stickySettingsFor(
  controls: readonly StickyControl[],
  sticky: StickySettings,
): Record<string, SettingValue> {
  return Object.fromEntries(controls.flatMap((control) => {
    const group = stickySettingGroup(control.name);
    const remembered = group ? sticky[group] : undefined;
    const value = remembered === undefined ? undefined : acceptedStickyValue(control, remembered);
    return value === undefined ? [] : [[control.name, value]];
  }));
}
