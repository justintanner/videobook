import { isNotebookGridAddress, NOTEBOOK_GRID_ADDRESS_SOURCE } from 'videobook-engine/notebook-mentions'

interface CommandParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  required: boolean;
  description: string;
  consumeRest?: boolean;
}

type CommandArgValue = string | number | boolean | string[];

interface SyncAudioAnchor {
  video_seconds: number;
  audio_cue?: string;
  audio_seconds?: number;
}

interface SyncAudioCommandArgs {
  asset_id: string;
  anchors: SyncAudioAnchor[];
}

interface ApplySfxCommandEntry {
  timestamp: number;
  type: string;
  description: string;
}

interface ApplySfxCommandArgs {
  asset_id: string;
  sfx: ApplySfxCommandEntry[];
}

interface ApplyCutEntry {
  cut_start: number;
  cut_end: number;
}

type CommandToolArgValue =
  | CommandArgValue
  | SyncAudioAnchor[]
  | ApplySfxCommandEntry[]
  | ApplyCutEntry[]
  | undefined;
export type CommandToolArgs = Record<string, CommandToolArgValue>;

export interface ServerCommand {
  workspaceActionId?: string;
  command: string;
  description: string;
  example?: string;
  category: 'action' | 'project' | 'context_menu' | 'viewer';
  icon: string;
  size: 'sm' | 'default' | 'lg';
  variant: 'default' | 'violet' | 'fuchsia' | 'blue' | 'zinc' | 'amber' | 'emerald' | 'pink';
  chevron: 'right' | 'down';
  params: CommandParam[];
  mcpTool?: { tool: string; adapter?: CommandAdapterName; autoInject?: string[]; injectParams?: Record<string, string | number | boolean> };
  uiAction?: string;
  exposure?: 'direct' | 'ui' | 'composite';
  canonical?: string;
  aliases?: string[];
  deprecated?: boolean;
}

interface QrOutroCommandArgs {
  qr_image_refs: string[];
  aspect_ratio?: '16:9' | '9:16' | '1:1';
}

interface TimewarpCommandArgs {
  asset_id: string;
  start_seconds: number;
  end_seconds: number;
  stretch_factor: number;
}

interface KeywordCommandArgs {
  asset_id: string;
  enabled?: boolean;
  max_keywords?: number;
  linger_seconds?: number;
  keywords?: string[];
}

const stripAt = (token: string): string => (token.startsWith('@') ? token.slice(1) : token);

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1).trim();
  return trimmed;
}

// A user-typed media reference is either a grid address (`@a1`) or a bare
// artifact id. Media kind is not encoded in the token and cannot be resolved
// client-side, so parsing only checks the token shape; the MCP tool looks the
// artifact up in the catalog and rejects wrong-kind references.
const ASSET_REF_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

function normalizeKeywordCommandArgs(
  args: Readonly<Record<string, unknown>>,
): KeywordCommandArgs {
  const assetValue = args.asset_id
  if (typeof assetValue !== 'string' || !assetValue.trim()) {
    throw new Error('/keywords requires a video cell or asset')
  }
  const assetId = stripAt(assetValue.trim())

  const inputsValue = args.inputs
  if (inputsValue === undefined) return { asset_id: assetId }
  if (!Array.isArray(inputsValue) || !inputsValue.every((input) => typeof input === 'string')) {
    throw new Error('/keywords inputs must be words')
  }
  const inputs = inputsValue.map((input) => input.trim()).filter(Boolean)
  if (inputs.length === 0) return { asset_id: assetId }

  const toggle = keywordToggle(inputs)
  if (toggle) return { asset_id: assetId, ...toggle }
  return { asset_id: assetId, keywords: inputs }
}

function keywordToggle(
  inputs: readonly string[],
): Omit<KeywordCommandArgs, 'asset_id'> | null {
  const mode = inputs[0]?.toLowerCase() ?? ''
  const rest = inputs.slice(1)
  if (['off', 'false', 'no', '0'].includes(mode)) {
    return rest.length === 0 ? { enabled: false } : null
  }
  if (!['on', 'true', 'yes', '1'].includes(mode) || rest.length > 2) return null
  if (rest.length === 0) return { enabled: true }
  const maxKeywords = Number(rest[0])
  if (!Number.isInteger(maxKeywords) || maxKeywords < 1 || maxKeywords > 20) return null
  if (rest.length === 1) return { enabled: true, max_keywords: maxKeywords }
  const lingerSeconds = Number(rest[1])
  if (!Number.isFinite(lingerSeconds) || lingerSeconds < 0.8 || lingerSeconds > 5) return null
  return {
    enabled: true,
    max_keywords: maxKeywords,
    linger_seconds: lingerSeconds,
  }
}

function outroAspectRatio(token: string): QrOutroCommandArgs['aspect_ratio'] | null {
  const word = token.toLowerCase();
  if (word === '16:9' || word === 'landscape') return '16:9';
  if (word === '9:16' || word === 'portrait') return '9:16';
  if (word === '1:1' || word === 'square') return '1:1';
  return null;
}

function normalizeQrOutroCommandArgs(tokens: readonly string[]): QrOutroCommandArgs {
  const inputs = tokens.map(stripAt);
  const qrImages: string[] = [];
  let aspectRatio: QrOutroCommandArgs['aspect_ratio'];

  for (const token of inputs) {
    const ratio = outroAspectRatio(token);
    if (ratio) {
      if (aspectRatio) throw new Error('/outroqr accepts only one aspect ratio');
      aspectRatio = ratio;
      continue;
    }
    if (!ASSET_REF_PATTERN.test(token)) {
      throw new Error(`Unrecognized /outroqr input: ${token}`);
    }
    qrImages.push(token);
    if (qrImages.length > 4) {
      throw new Error('/outroqr accepts at most 4 QR images');
    }
  }

  if (qrImages.length === 0) {
    throw new Error('/outroqr requires at least one QR image cell or asset');
  }

  return {
    qr_image_refs: qrImages,
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
  };
}

export function normalizeApplySfxCommandArgs(
  args: Readonly<Record<string, unknown>>,
): ApplySfxCommandArgs {
  const assetValue = args.asset_id;
  const timestampValue = args.timestamp;
  const typeValue = args.type;
  const descriptionValue = args.description;
  if (typeof assetValue !== 'string' || !assetValue.trim()) {
    throw new Error('/apply-sfx requires a video cell or asset');
  }
  const assetId = stripAt(assetValue.trim());
  if (typeof timestampValue !== 'string' && typeof timestampValue !== 'number') {
    throw new Error('/apply-sfx requires a timestamp');
  }
  const timestamp = typeof timestampValue === 'number'
    ? timestampValue
    : parseCommandTimestamp(timestampValue, '/apply-sfx');
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error('/apply-sfx timestamp must be 0 or later');
  }
  if (typeof typeValue !== 'string' || !typeValue.trim()) {
    throw new Error('/apply-sfx requires an effect type');
  }
  if (typeof descriptionValue !== 'string' || !descriptionValue.trim()) {
    throw new Error('/apply-sfx requires an effect description');
  }
  return {
    asset_id: assetId,
    sfx: [{
      timestamp,
      type: typeValue.trim(),
      description: descriptionValue.trim(),
    }],
  };
}

function parseCommandTimestamp(raw: string, command: string): number {
  const token = raw.trim().replace(/s$/i, '');
  const parts = token.split(':');
  if (parts.length === 1) {
    const seconds = Number(parts[0]);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    throw new Error(`Invalid ${command} timestamp: ${raw}`);
  }
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error(`Invalid ${command} timestamp: ${raw}`);
  }
  if (!parts.every((part) => /^\d+(?:\.\d+)?$/.test(part))) {
    throw new Error(`Invalid ${command} timestamp: ${raw}`);
  }
  const values = parts.map(Number);
  if (parts.length === 2) return values[0] * 60 + values[1];
  return values[0] * 3600 + values[1] * 60 + values[2];
}

export function normalizeTimewarpCommandArgs(
  args: Readonly<Record<string, unknown>>,
): TimewarpCommandArgs {
  const assetValue = args.asset_id;
  const rangeValue = args.range;
  const factorValue = args.factor;
  if (typeof assetValue !== 'string' || !assetValue.trim()) {
    throw new Error('/timewarp requires a video cell or asset');
  }
  const assetId = stripAt(assetValue.trim());
  if (typeof rangeValue !== 'string') {
    throw new Error('/timewarp requires a <start>-<end> range');
  }
  const rangeMatch = /^(.+)-(.+)$/.exec(rangeValue.trim());
  if (!rangeMatch) throw new Error('/timewarp requires a <start>-<end> range');
  const startSeconds = parseCommandTimestamp(rangeMatch[1], '/timewarp');
  const endSeconds = parseCommandTimestamp(rangeMatch[2], '/timewarp');
  if (startSeconds >= endSeconds) {
    throw new Error('/timewarp start must be before end');
  }
  if (typeof factorValue !== 'string' && typeof factorValue !== 'number') {
    throw new Error('/timewarp requires a stretch factor');
  }
  const factorToken = String(factorValue).trim();
  if (!/^\d+(?:\.\d+)?x?$/i.test(factorToken)) {
    throw new Error(`Invalid /timewarp stretch factor: ${factorToken}`);
  }
  const stretchFactor = Number(factorToken.replace(/x$/i, ''));
  if (!Number.isFinite(stretchFactor) || stretchFactor < 0.25 || stretchFactor > 4) {
    throw new Error('/timewarp stretch factor must be between 0.25x and 4x');
  }
  if (stretchFactor === 1) throw new Error('/timewarp stretch factor 1x is a no-op');
  return {
    asset_id: assetId,
    start_seconds: startSeconds,
    end_seconds: endSeconds,
    stretch_factor: stretchFactor,
  };
}

function stripOptionalQuotes(raw: string): string {
  const value = raw.trim();
  const first = value[0];
  const last = value[value.length - 1];
  const startsQuoted = first === '"' || first === "'";
  const endsQuoted = last === '"' || last === "'";
  if (startsQuoted || endsQuoted) {
    if (!startsQuoted || first !== last || value.length < 2) {
      throw new Error(`/sync-audio has mismatched quotes: ${raw}`);
    }
    return value.slice(1, -1).trim();
  }
  return value;
}

function isCommandTimestamp(raw: string): boolean {
  const token = raw.trim().replace(/s$/i, '');
  const parts = token.split(':');
  if (parts.length < 1 || parts.length > 3) return false;
  return parts.every((part) => /^\d+(?:\.\d+)?$/.test(part));
}

function parseSyncAudioTarget(raw: string): Omit<SyncAudioAnchor, 'video_seconds'> {
  const untrimmedTarget = raw.trim();
  const quoted = untrimmedTarget.startsWith('"') || untrimmedTarget.startsWith("'");
  const target = stripOptionalQuotes(raw);
  if (!target) throw new Error('/sync-audio anchor target cannot be empty');
  if (!quoted && isCommandTimestamp(target)) {
    return { audio_seconds: parseCommandTimestamp(target, '/sync-audio') };
  }
  return { audio_cue: target };
}

export function normalizeSyncAudioCommandArgs(
  args: Readonly<Record<string, unknown>>,
): SyncAudioCommandArgs {
  const assetValue = args.asset_id;
  const mappingsValue = args.mappings;
  if (typeof assetValue !== 'string' || !assetValue.trim()) {
    throw new Error('/sync-audio requires a video cell or asset');
  }
  const assetId = stripAt(assetValue.trim());
  if (typeof mappingsValue !== 'string' || !mappingsValue.trim()) {
    throw new Error('/sync-audio requires at least one video-time=audio-target mapping');
  }

  const mappings = mappingsValue.split(';');
  const anchors: SyncAudioAnchor[] = [];
  for (const mapping of mappings) {
    const separator = mapping.indexOf('=');
    if (separator <= 0 || separator !== mapping.lastIndexOf('=')) {
      throw new Error(`Invalid /sync-audio mapping: ${mapping.trim()}`);
    }
    const videoRaw = mapping.slice(0, separator).trim();
    const targetRaw = mapping.slice(separator + 1).trim();
    if (!videoRaw || !targetRaw) {
      throw new Error(`Invalid /sync-audio mapping: ${mapping.trim()}`);
    }
    const videoSeconds = parseCommandTimestamp(videoRaw, '/sync-audio');
    const previous = anchors[anchors.length - 1];
    if (previous && videoSeconds <= previous.video_seconds) {
      throw new Error('/sync-audio video timestamps must be strictly increasing');
    }
    anchors.push({ video_seconds: videoSeconds, ...parseSyncAudioTarget(targetRaw) });
  }

  return { asset_id: assetId, anchors };
}

function normalizeTrimCommandArgs(
  args: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const assetValue = args.asset_id;
  if (typeof assetValue !== 'string' || !assetValue.trim()) {
    throw new Error('Trim command requires an asset ID');
  }
  const assetId = stripAt(assetValue.trim());

  let trimStart: number | undefined;
  let trimEnd: number | undefined;
  let cutStart: number | undefined;
  let cutEnd: number | undefined;

  const startVal = args.trim_start !== undefined ? args.trim_start : args.start;
  if (startVal !== undefined && startVal !== null && startVal !== '') {
    if (typeof startVal === 'number') {
      trimStart = startVal;
    } else if (typeof startVal === 'string') {
      trimStart = parseCommandTimestamp(startVal, '/trim');
    }
  }

  const endVal = args.trim_end !== undefined ? args.trim_end : args.end;
  if (endVal !== undefined && endVal !== null && endVal !== '') {
    if (typeof endVal === 'number') {
      trimEnd = endVal;
    } else if (typeof endVal === 'string') {
      trimEnd = parseCommandTimestamp(endVal, '/trim');
    }
  }

  if (args.cut_start !== undefined && args.cut_start !== null && args.cut_start !== '') {
    if (typeof args.cut_start === 'number') {
      cutStart = args.cut_start;
    } else if (typeof args.cut_start === 'string') {
      cutStart = parseCommandTimestamp(args.cut_start, '/trim');
    }
  }

  if (args.cut_end !== undefined && args.cut_end !== null && args.cut_end !== '') {
    if (typeof args.cut_end === 'number') {
      cutEnd = args.cut_end;
    } else if (typeof args.cut_end === 'string') {
      cutEnd = parseCommandTimestamp(args.cut_end, '/trim');
    }
  }

  if (trimStart !== undefined && (!Number.isFinite(trimStart) || trimStart < 0)) {
    throw new Error('trim_start must be >= 0');
  }
  if (trimEnd !== undefined && (!Number.isFinite(trimEnd) || trimEnd < 0)) {
    throw new Error('trim_end must be >= 0');
  }
  if (trimStart !== undefined && trimEnd !== undefined && trimStart >= trimEnd) {
    throw new Error('trim_start must be less than trim_end');
  }

  if (cutStart !== undefined && (!Number.isFinite(cutStart) || cutStart < 0)) {
    throw new Error('cut_start must be >= 0');
  }
  if (cutEnd !== undefined && (!Number.isFinite(cutEnd) || cutEnd < 0)) {
    throw new Error('cut_end must be >= 0');
  }
  if (cutStart !== undefined && cutEnd !== undefined && cutStart >= cutEnd) {
    throw new Error('cut_start must be less than cut_end');
  }

  return {
    asset_id: assetId,
    ...(trimStart !== undefined && { trim_start: trimStart }),
    ...(trimEnd !== undefined && { trim_end: trimEnd }),
    ...(cutStart !== undefined && { cut_start: cutStart }),
    ...(cutEnd !== undefined && { cut_end: cutEnd }),
  };
}

function normalizeApplyCutsCommandArgs(
  args: Readonly<Record<string, unknown>>,
): { asset_id: string; cuts: Array<{ cut_start: number; cut_end: number }> } {
  const assetValue = args.asset_id;
  if (typeof assetValue !== 'string' || !assetValue.trim()) {
    throw new Error('/apply-cuts requires a video cell or asset');
  }
  const assetId = stripAt(assetValue.trim());

  const cutsRaw = args.cuts;
  if (!cutsRaw) throw new Error('/apply-cuts requires at least one cut range');

  const cutsArray: unknown[] = Array.isArray(cutsRaw) ? cutsRaw : [cutsRaw];
  if (cutsArray.length === 0) throw new Error('/apply-cuts requires at least one cut range');

  const cuts: Array<{ cut_start: number; cut_end: number }> = [];

  for (const raw of cutsArray) {
    if (typeof raw === 'object' && raw !== null && 'cut_start' in raw && 'cut_end' in raw) {
      const cStart = Number((raw as Record<string, unknown>).cut_start);
      const cEnd = Number((raw as Record<string, unknown>).cut_end);
      if (!Number.isFinite(cStart) || !Number.isFinite(cEnd) || cStart >= cEnd || cStart < 0) {
        throw new Error(`Invalid cut range object: ${JSON.stringify(raw)}`);
      }
      cuts.push({ cut_start: cStart, cut_end: cEnd });
      continue;
    }

    if (typeof raw !== 'string') {
      throw new Error(`/apply-cuts range must be string or object, got: ${typeof raw}`);
    }

    const token = raw.trim();
    const dashIdx = token.indexOf('-');
    if (dashIdx <= 0 || dashIdx === token.length - 1) {
      throw new Error(`Invalid /apply-cuts range format: ${token}. Expected <start>-<end>`);
    }

    const startStr = token.slice(0, dashIdx);
    const endStr = token.slice(dashIdx + 1);

    const cStart = parseCommandTimestamp(startStr, '/apply-cuts');
    const cEnd = parseCommandTimestamp(endStr, '/apply-cuts');

    if (cStart >= cEnd) {
      throw new Error(`/apply-cuts start (${startStr}) must be before end (${endStr})`);
    }

    cuts.push({ cut_start: cStart, cut_end: cEnd });
  }

  return { asset_id: assetId, cuts };
}

function normalizeTranslateSubtitlesCommandArgs(
  args: Readonly<Record<string, unknown>>,
): { asset_id: string; language: string } {
  const assetValue = args.asset_id;
  if (typeof assetValue !== 'string' || !assetValue.trim()) {
    throw new Error('/translate-subs requires an asset ID');
  }
  const assetId = stripAt(assetValue.trim());

  const langVal = args.language !== undefined ? args.language : args.target_language;
  if (typeof langVal !== 'string' || !langVal.trim()) {
    throw new Error('/translate-subs requires a target language code');
  }
  const language = langVal.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(language)) {
    throw new Error('/translate-subs target language must be a two-letter ISO code (e.g. es, fr, de)');
  }

  return { asset_id: assetId, language };
}

type CommandAdapterFn = (args: Readonly<Record<string, unknown>>) => CommandToolArgs;

const NOTEBOOK_DESTINATION_PATTERN = new RegExp(
  `^@?${NOTEBOOK_GRID_ADDRESS_SOURCE}$`,
  'iu',
);

const REWRITE_PLATFORMS = new Set(['ig', 'tiktok', 'youtube']);
const QR_STYLES = new Set(['normal', 'line', 'dsj', 'bubble', 'func']);
const ORIENTATIONS = new Set(['landscape', 'portrait', 'square']);
const POST_ASSET_PREFIX = /^(?:vid|img|aud|asset|final|script)-[a-z0-9-]+$/i;
const POST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeRewriteScriptCommandArgs(
  args: Readonly<Record<string, unknown>>,
): CommandToolArgs {
  const result: CommandToolArgs = { ...(args as CommandToolArgs) };
  const platformRaw = typeof args.platform === 'string' ? args.platform.trim() : '';
  const prompt = typeof args.custom_prompt === 'string' ? args.custom_prompt.trim() : '';
  const platform = platformRaw.toLowerCase();
  if (platform && REWRITE_PLATFORMS.has(platform)) {
    result.platform = platform;
    if (prompt) result.custom_prompt = prompt;
    else delete result.custom_prompt;
    return result;
  }
  delete result.platform;
  const custom = [platformRaw, prompt].filter(Boolean).join(' ');
  if (custom) result.custom_prompt = custom;
  else delete result.custom_prompt;
  return result;
}

function normalizeQrbtfCommandArgs(
  args: Readonly<Record<string, unknown>>,
): CommandToolArgs {
  const result: CommandToolArgs = { ...(args as CommandToolArgs) };
  const value = typeof args.value === 'string' ? args.value.trim() : '';
  const styleRaw = typeof args.style === 'string' ? args.style.trim() : '';
  if (!value && !styleRaw) return result;
  const styleTokens = styleRaw.split(/\s+/).filter(Boolean);
  const last = styleTokens[styleTokens.length - 1]?.toLowerCase() ?? '';
  if (styleTokens.length === 1 && QR_STYLES.has(last)) {
    result.style = last;
    if (value) result.value = value;
    return result;
  }
  if (styleTokens.length > 1 && QR_STYLES.has(last)) {
    result.style = last;
    result.value = [value, styleTokens.slice(0, -1).join(' ')].filter(Boolean).join(' ');
    return result;
  }
  delete result.style;
  result.value = [value, styleRaw].filter(Boolean).join(' ');
  return result;
}

function isPostAssetToken(token: string): boolean {
  const bare = stripAt(token);
  return token.startsWith('@')
    || isNotebookGridAddress(bare)
    || POST_UUID.test(bare)
    || POST_ASSET_PREFIX.test(bare);
}

export function normalizePostCommandArgs(rest: string): { asset_ref?: string; text?: string } {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};
  const [first, ...more] = tokens;
  if (first && isPostAssetToken(first)) {
    return {
      asset_ref: stripAt(first),
      ...(more.length > 0 ? { text: more.join(' ') } : {}),
    };
  }
  return { text: tokens.join(' ') };
}

export function postCommandTarget(rest: string): { reference?: string; text?: string } {
  const parsed = normalizePostCommandArgs(rest);
  return {
    ...(parsed.asset_ref ? { reference: rest.trim().split(/\s+/u)[0] } : {}),
    ...(parsed.text ? { text: parsed.text } : {}),
  };
}

export const COMMAND_ADAPTERS = {
  qr_outro: (args) => {
    const inputs = args.inputs;
    if (!Array.isArray(inputs) || !inputs.every((input) => typeof input === 'string')) {
      throw new Error('/outroqr inputs are required');
    }
    const result: CommandToolArgs = { ...(args as CommandToolArgs) };
    delete result.inputs;
    return { ...result, ...normalizeQrOutroCommandArgs(inputs as string[]) };
  },
  keywords: (args) => {
    const normalized = normalizeKeywordCommandArgs(args);
    const result: CommandToolArgs = { ...(args as CommandToolArgs) };
    delete result.inputs;
    return { ...result, ...normalized };
  },
  change_speed: (args) => {
    const result: CommandToolArgs = { ...(args as CommandToolArgs) };
    if (!('speed' in result)) return result;
    const val = result.speed;
    delete result.speed;
    const token = typeof val === 'number' ? String(val) : typeof val === 'string' ? val.trim() : '';
    const speedUsage = 'Usage: /speed @asset <0.25-4 or 8.32s>';
    if (!token) throw new Error(speedUsage);
    if (/s$/i.test(token)) {
      const seconds = Number(token.slice(0, -1));
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(speedUsage);
      result.target_duration_seconds = seconds;
      return result;
    }
    const speed = Number(token.replace(/x$/i, ''));
    if (!Number.isFinite(speed)) throw new Error(speedUsage);
    result.speed = speed;
    return result;
  },
  duplicate: (args) => {
    const result: CommandToolArgs = { ...(args as CommandToolArgs) };
    const nameValue = typeof args.new_name === 'string'
      ? args.new_name.trim()
      : '';
    const destinationValue = typeof args.destination === 'string'
      ? args.destination.trim()
      : '';
    delete result.new_name;
    delete result.destination;
    if (NOTEBOOK_DESTINATION_PATTERN.test(destinationValue)) {
      result.destination = stripAt(destinationValue).toLowerCase();
      if (nameValue) result.new_name = stripWrappingQuotes(nameValue);
      return result;
    }
    const tokens = [...nameValue.split(/\s+/), destinationValue].filter(Boolean);
    const destinations = tokens.filter((token) => NOTEBOOK_DESTINATION_PATTERN.test(token));
    if (destinations.length > 1) {
      throw new Error('Usage: /duplicate @asset [@cell] [name]');
    }
    if (destinations.length === 1) {
      result.destination = stripAt(destinations[0]!).toLowerCase();
      const newName = tokens.filter((token) => token !== destinations[0]).join(' ');
      if (newName) result.new_name = stripWrappingQuotes(newName);
      return result;
    }
    if (tokens.length > 0) result.new_name = stripWrappingQuotes(tokens.join(' '));
    return result;
  },
  timewarp: (args) => {
    const normalized = normalizeTimewarpCommandArgs(args);
    const result: CommandToolArgs = { ...(args as CommandToolArgs) };
    delete result.range;
    delete result.factor;
    return { ...result, ...normalized };
  },
  sync_audio: (args) => {
    const normalized = normalizeSyncAudioCommandArgs(args);
    const result: CommandToolArgs = { ...(args as CommandToolArgs) };
    delete result.mappings;
    return { ...result, ...normalized };
  },
  apply_sfx: (args) => {
    const normalized = normalizeApplySfxCommandArgs(args);
    const result: CommandToolArgs = { ...(args as CommandToolArgs) };
    delete result.timestamp;
    delete result.type;
    delete result.description;
    return { ...result, ...normalized };
  },
  rewrite_script: (args) => normalizeRewriteScriptCommandArgs(args),
  qrbtf: (args) => normalizeQrbtfCommandArgs(args),
  trim: (args) => {
    const normalized = normalizeTrimCommandArgs(args);
    const result: CommandToolArgs = { ...(args as CommandToolArgs) };
    delete result.start;
    delete result.end;
    return { ...result, ...(normalized as CommandToolArgs) };
  },
  apply_cuts: (args) => {
    const normalized = normalizeApplyCutsCommandArgs(args);
    const result: CommandToolArgs = { ...(args as CommandToolArgs) };
    delete result.cuts;
    return { ...result, ...normalized };
  },
  translate_subtitles: (args) => {
    const normalized = normalizeTranslateSubtitlesCommandArgs(args);
    const result: CommandToolArgs = { ...(args as CommandToolArgs) };
    delete result.target_language;
    return { ...result, ...(normalized as CommandToolArgs) };
  },
} satisfies Record<string, CommandAdapterFn>;

type CommandAdapterName = keyof typeof COMMAND_ADAPTERS;

function foldOrientation(args: CommandToolArgs): CommandToolArgs {
  const raw = args.orientation;
  if (typeof raw !== 'string') return args;
  const orientation = raw.trim().toLowerCase();
  if (!orientation) {
    const result = { ...args };
    delete result.orientation;
    return result;
  }
  if (!ORIENTATIONS.has(orientation)) {
    throw new Error('Orientation must be landscape, portrait, or square');
  }
  if (raw === orientation) return args;
  return { ...args, orientation };
}

export function adaptCommandArgs(
  adapterName: string | undefined,
  args: Readonly<Record<string, unknown>>,
): CommandToolArgs {
  if (!adapterName) return foldOrientation(args as CommandToolArgs);
  const adapterFn = COMMAND_ADAPTERS[adapterName as CommandAdapterName];
  if (!adapterFn) throw new Error(`Unknown command adapter: ${adapterName}`);
  return foldOrientation(adapterFn(args));
}

const SECOND_COUNT_PARAMS = new Set([
  'target_duration_seconds',
  'transition_seconds',
  'overlap',
  'timestamp',
  'start',
  'duration',
]);

function parseNumberToken(token: string, paramName: string): string | number {
  const stripped = stripAt(token);
  const seconds = SECOND_COUNT_PARAMS.has(paramName)
    ? /^(\d+(?:\.\d+)?)(?:s|sec|secs|second|seconds)$/i.exec(stripped)
    : null;
  const unit = seconds
    ?? (paramName === 'boost' ? /^(\d+(?:\.\d+)?)x$/i.exec(stripped) : null)
    ?? (paramName === 'volume' ? /^(\d+(?:\.\d+)?)%$/i.exec(stripped) : null);
  const parsed = Number(unit?.[1] ?? stripped);
  return Number.isFinite(parsed) ? parsed : stripped;
}

function parseBooleanToken(token: string): string | boolean {
  const stripped = stripAt(token).toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(stripped)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(stripped)) return false;
  return stripAt(token);
}

function parseTokenValue(token: string, param: CommandParam): CommandArgValue {
  if (param.type === 'number') return parseNumberToken(token, param.name);
  if (param.type === 'boolean') {
    const parsed = parseBooleanToken(token);
    if (typeof parsed !== 'boolean') throw new Error(`${param.name} must be on or off`);
    return parsed;
  }
  return stripAt(token);
}

function booleanFlag(token: string, param: CommandParam): boolean | null {
  if (param.type !== 'boolean') return null;
  const word = stripAt(token).toLowerCase();
  if (word === param.name.toLowerCase()) return true;
  if (['true', 'yes', 'y', 'on'].includes(word)) return true;
  if (['false', 'no', 'n', 'off'].includes(word)) return false;
  return null;
}

export function parseCommandArgs(rest: string, params: CommandParam[]): Record<string, CommandArgValue> {
  if (!rest || params.length === 0) return {};

  const rawTokens = rest.split(/\s+/).filter((token) => token.length > 0);
  const args: Record<string, CommandArgValue> = {};
  const tokens: string[] = [];
  for (const token of rawTokens) {
    const claimant = params.find((param) =>
      param.type === 'boolean' && !(param.name in args) && booleanFlag(token, param) !== null);
    if (claimant) {
      args[claimant.name] = booleanFlag(token, claimant)!;
      continue;
    }
    tokens.push(token);
  }
  const lastParam = params[params.length - 1];
  let tokenLimit = tokens.length;

  if (lastParam?.type === 'boolean' && tokens.length > 1 && tokens.length < params.length) {
    const parsed = parseBooleanToken(tokens[tokens.length - 1]);
    if (typeof parsed === 'boolean') {
      args[lastParam.name] = parsed;
      tokenLimit -= 1;
    }
  }

  for (let i = 0; i < params.length; i++) {
    if (i >= tokenLimit) break;
    const param = params[i];
    if (param.name in args) continue;
    const isLast = i === params.length - 1;

    if (isLast && param.type === 'string[]') {
      args[param.name] = tokens.slice(i, tokenLimit).map(stripAt);
    } else if ((isLast || param.consumeRest) && param.type === 'string') {
      let remaining = tokens.slice(i, tokenLimit);
      if (param.name === 'new_name' && remaining.length > 1 && remaining[0] === 'to') {
        remaining = remaining.slice(1);
      }
      args[param.name] = stripWrappingQuotes(stripAt(remaining.join(' ')));
      if (param.consumeRest) break;
    } else {
      args[param.name] = parseTokenValue(tokens[i], param);
    }
  }

  return args;
}

const TRENDING_OPS = new Set(['schedule', 'unschedule', 'list', 'run', 'status']);
const TRENDING_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TRENDING_COUNTRY = /^[A-Za-z]{2}$/;

export function parseTrendingCommandArgs(rest: string): Record<string, string> {
  const tokens = rest.trim().split(/\s+/).filter((token) => token.length > 0);
  const args: Record<string, string> = {};
  let index = 0;
  const head = tokens[0]?.toLowerCase();
  if (head && TRENDING_OPS.has(head)) {
    args.op = head;
    index = 1;
  } else {
    args.op = 'run';
  }
  const country = tokens[index];
  if (country && TRENDING_COUNTRY.test(country)) {
    args.country = country.toUpperCase();
    index += 1;
  }
  const date = tokens[index];
  if (date && TRENDING_DATE.test(date)) {
    args.date = date;
    index += 1;
  }
  if (index < tokens.length) throw new Error(`Unexpected /trending argument "${tokens[index]}"`);
  return args;
}

export function parseSlashCommandArgs(command: Pick<ServerCommand, 'command' | 'params'>, rest: string): Record<string, CommandArgValue> {
  if (command.command === '/trending') return parseTrendingCommandArgs(rest);
  return parseCommandArgs(rest, command.params);
}

export function applyInjectedCommandArgs(
  command: Pick<ServerCommand, 'command' | 'mcpTool'>,
  parsed: CommandToolArgs,
): CommandToolArgs {
  const injected = command.mcpTool?.injectParams ?? {};
  if (command.command === '/trending') return { ...injected, ...parsed };
  return { ...parsed, ...injected };
}

export function selectCommandForInput(commands: ServerCommand[], commandStr: string, rest: string): ServerCommand | undefined {
  const normalized = commandStr.toLowerCase();
  const exactMatches = commands.filter((command) => command.command.toLowerCase() === normalized);
  const matches = exactMatches.length > 0
    ? exactMatches
    : commands.filter((command) => command.aliases?.some((alias) => alias.toLowerCase() === normalized));
  if (matches.length <= 1) return matches[0];

  const firstToken = rest.split(/\s+/).find(Boolean) ?? '';
  const firstParam = (cmd: ServerCommand) => cmd.params[0]?.name ?? '';
  const takesAssetFirst = (cmd: ServerCommand) => /asset|ref|source/.test(firstParam(cmd));

  if (firstToken.startsWith('@')) {
    return matches.find(takesAssetFirst) ?? matches[0];
  }

  return matches.find((cmd) => !takesAssetFirst(cmd)) ?? matches[0];
}
