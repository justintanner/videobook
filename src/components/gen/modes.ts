import type { ModelModes, ModeSpec, ModelOption } from './types';

/** True when a form value counts as "empty" for inference/filtering.
 *  Numbers (incl. 0) and booleans are always non-empty. */
export function isEmptyModeValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Resolve a mode spec by key, falling back to the default (then first) mode. */
export function getMode(modes: ModelModes, key: string | null): ModeSpec {
  const byKey = key ? modes.modes.find((m) => m.key === key) : undefined;
  if (byKey) return byKey;
  return modes.modes.find((m) => m.key === modes.default_mode) ?? modes.modes[0];
}

/** Params visible in a mode: shared (minus this mode's hidden) plus mode-owned. */
export function visibleParams(modes: ModelModes, key: string): Set<string> {
  const mode = getMode(modes, key);
  const hidden = new Set(mode.hidden_shared_params ?? []);
  const visible = new Set<string>();
  for (const p of modes.shared_params) if (!hidden.has(p)) visible.add(p);
  for (const p of mode.params) visible.add(p);
  return visible;
}

/**
 * Infer the active mode from filled values. Modes are scanned in REVERSE
 * declaration order; the first whose *discriminating* params (its own params
 * that no earlier mode also owns) hold a non-empty value wins. This handles
 * superset modes correctly: omni's "edit" owns image_slugs too, but a filled
 * image_slugs with no clip infers "refs" because video_slug (edit's only
 * discriminator) is empty. Falls back to default_mode when nothing matches.
 */
export function inferModeKey(modes: ModelModes, values: Record<string, unknown>): string {
  const list = modes.modes;
  for (let i = list.length - 1; i >= 0; i--) {
    const earlier = new Set<string>();
    for (let j = 0; j < i; j++) for (const p of list[j].params) earlier.add(p);
    const discriminating = list[i].params.filter((p) => !earlier.has(p));
    if (discriminating.some((p) => !isEmptyModeValue(values[p]))) return list[i].key;
  }
  return modes.default_mode;
}

/**
 * Keep only the values visible in the active mode; OMIT the rest (don't blank
 * them). The omni tool coalesces absent/blank identically, so dropping the keys
 * of inactive modes keeps the provider payload byte-identical.
 */
export function filterValuesForMode(
  modes: ModelModes,
  key: string,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const visible = visibleParams(modes, key);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (visible.has(k)) out[k] = v;
  }
  return out;
}

/** A mode's required params (mode.required) that are currently empty. */
export function modeRequiredMissing(mode: ModeSpec, values: Record<string, unknown>): string[] {
  return (mode.required ?? []).filter((p) => isEmptyModeValue(values[p]));
}

/** Union of every asset-slot param across all of a model's modes. */
export function modeAssetParams(modes: ModelModes): Set<string> {
  const out = new Set<string>();
  for (const mode of modes.modes) {
    for (const slot of mode.asset_slots ?? []) out.add(slot.param);
  }
  return out;
}

/**
 * Live warnings when the active mode's per-slot max or a param_overrides
 * maxItems is exceeded by current values (e.g. 7 references carried into the
 * edit mode, which caps refs at 5). Server validation stays authoritative;
 * these gate the button early with a friendly message.
 */
export function modeBudgetWarnings(mode: ModeSpec, values: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  for (const slot of mode.asset_slots ?? []) {
    if (slot.max == null) continue;
    const n = count(values[slot.param]);
    if (n > slot.max) warnings.push(`${mode.label}: ${slot.label} allows at most ${slot.max} (got ${n}).`);
  }
  for (const [param, ov] of Object.entries(mode.param_overrides ?? {})) {
    if (ov.maxItems == null) continue;
    const n = count(values[param]);
    if (n > ov.maxItems) {
      warnings.push(`${mode.label}: ${param.replace(/_/g, ' ')} allows at most ${ov.maxItems} (got ${n}).`);
    }
  }
  return warnings;
}

/** Resolve the tool a submit should call: the active mode's own tool_name if
 *  set (tool-per-mode models), else the option's tool_name. */
export function effectiveToolName(
  option: Pick<ModelOption, 'tool_name' | 'modes'>,
  key: string | null,
): string {
  if (option.modes) {
    const mode = getMode(option.modes, key);
    if (mode.tool_name) return mode.tool_name;
  }
  return option.tool_name;
}

/** Clip window covering the last ~2s of a source clip, for one-click extend.
 *  null when the duration is unknown/non-positive (the server then defaults to
 *  the full clip). Rounded to 2 decimals; capped at the 10s trim timeline. */
export function tailClipWindow(
  durationSeconds: number | null | undefined,
): { start: number; ends: number } | null {
  if (durationSeconds == null || !(durationSeconds > 0)) return null;
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const ends = Math.min(durationSeconds, 10);
  const start = Math.max(0, ends - 2);
  return { start: round2(start), ends: round2(ends) };
}

/** The mode an "extend this clip" action switches to: the first mode whose
 *  params include video_slug (omni's "edit"). null when the model has none. */
export function findExtendModeKey(modes: ModelModes | null | undefined): string | null {
  if (!modes) return null;
  const mode = modes.modes.find((m) => m.params.includes('video_slug'));
  return mode?.key ?? null;
}
