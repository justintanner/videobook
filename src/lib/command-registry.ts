export interface CommandParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  required: boolean;
  description: string;
}

export type CommandArgValue = string | number | boolean | string[];

export interface SyncAudioAnchor {
  video_seconds: number;
  audio_cue?: string;
  audio_seconds?: number;
}

export interface SyncAudioCommandArgs {
  asset_id: string;
  anchors: SyncAudioAnchor[];
}

export interface ApplySfxCommandEntry {
  timestamp: number;
  type: string;
  description: string;
}

export interface ApplySfxCommandArgs {
  asset_id: string;
  sfx: ApplySfxCommandEntry[];
}

export interface ApplyCutEntry {
  cut_start: number;
  cut_end: number;
}

export type CommandToolArgValue =
  | CommandArgValue
  | SyncAudioAnchor[]
  | ApplySfxCommandEntry[]
  | ApplyCutEntry[]
  | undefined;
export type CommandToolArgs = Record<string, CommandToolArgValue>;

export interface ServerCommand {
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
  onMount?: string[];
  exposure?: 'direct' | 'ui' | 'composite';
  canonical?: string;
  aliases?: string[];
  deprecated?: boolean;
}

export type CommandDescriptor = ServerCommand;

export interface QrOutroCommandArgs {
  qr_image_slugs: string[];
  aspect_ratio?: '16:9' | '9:16' | '1:1';
}

export interface TimewarpCommandArgs {
  asset_id: string;
  start_seconds: number;
  end_seconds: number;
  stretch_factor: number;
}

export interface KeywordCommandArgs {
  asset_id: string;
  enabled?: boolean;
  max_keywords?: number;
  linger_seconds?: number;
  keywords?: string[];
}

export function filterCommandsByMountKeys(
  commands: ServerCommand[],
  activeKeys: ReadonlySet<string>,
): ServerCommand[] {
  return commands.filter((cmd) => {
    if (cmd.deprecated) return false;
    if (!cmd.onMount || cmd.onMount.length === 0) return true;
    return cmd.onMount.every((key) => activeKeys.has(key));
  });
}

const stripAt = (token: string): string => (token.startsWith('@') ? token.slice(1) : token);

export function normalizeKeywordCommandArgs(
  args: Readonly<Record<string, unknown>>,
): KeywordCommandArgs {
  const assetValue = args.asset_id
  if (typeof assetValue !== 'string' || !assetValue.trim()) {
    throw new Error('/keywords requires a video asset')
  }
  const assetId = stripAt(assetValue.trim())
  if (!assetId.startsWith('vid-')) throw new Error('/keywords requires a vid-* asset')

  const inputsValue = args.inputs
  if (inputsValue === undefined) return { asset_id: assetId }
  if (!Array.isArray(inputsValue) || !inputsValue.every((input) => typeof input === 'string')) {
    throw new Error('/keywords inputs must be words')
  }
  const inputs = inputsValue.map((input) => input.trim()).filter(Boolean)
  if (inputs.length === 0) return { asset_id: assetId }

  const mode = inputs[0].toLowerCase()
  if (['off', 'false', 'no', '0'].includes(mode)) {
    if (inputs.length > 1) throw new Error('/keywords off does not accept extra inputs')
    return { asset_id: assetId, enabled: false }
  }
  if (['on', 'true', 'yes', '1'].includes(mode)) {
    if (inputs.length > 3) throw new Error('/keywords on accepts only [max] [linger]')
    const maxKeywords = inputs[1] === undefined ? undefined : Number(inputs[1])
    const lingerSeconds = inputs[2] === undefined ? undefined : Number(inputs[2])
    if (maxKeywords !== undefined && (!Number.isInteger(maxKeywords) || maxKeywords < 1 || maxKeywords > 20)) {
      throw new Error('/keywords max must be an integer from 1 to 20')
    }
    if (lingerSeconds !== undefined && (!Number.isFinite(lingerSeconds) || lingerSeconds < 0.8 || lingerSeconds > 5)) {
      throw new Error('/keywords linger must be between 0.8 and 5 seconds')
    }
    return {
      asset_id: assetId,
      enabled: true,
      ...(maxKeywords === undefined ? {} : { max_keywords: maxKeywords }),
      ...(lingerSeconds === undefined ? {} : { linger_seconds: lingerSeconds }),
    }
  }

  return { asset_id: assetId, keywords: inputs }
}

export function normalizeQrOutroCommandArgs(tokens: readonly string[]): QrOutroCommandArgs {
  const inputs = tokens.map(stripAt);
  const qrImages: string[] = [];
  let aspectRatio: QrOutroCommandArgs['aspect_ratio'];

  for (const token of inputs) {
    if (token.startsWith('img-')) {
      qrImages.push(token);
      if (qrImages.length > 4) {
        throw new Error('/outroqr accepts at most 4 QR images');
      }
      continue;
    }
    if (token === '16:9' || token === '9:16' || token === '1:1') {
      if (aspectRatio) throw new Error('/outroqr accepts only one aspect ratio');
      aspectRatio = token;
      continue;
    }
    throw new Error(`Unrecognized /outroqr input: ${token}`);
  }

  if (qrImages.length === 0) {
    throw new Error('/outroqr requires at least one QR img-* asset');
  }

  return {
    qr_image_slugs: qrImages,
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
    throw new Error('/apply-sfx requires a video asset');
  }
  const assetId = stripAt(assetValue.trim());
  if (!assetId.startsWith('vid-')) {
    throw new Error('/apply-sfx requires a vid-* asset');
  }
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
    throw new Error('/timewarp requires a video asset');
  }
  const assetId = stripAt(assetValue.trim());
  if (!assetId.startsWith('vid-')) throw new Error('/timewarp requires a vid-* asset');
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
    throw new Error('/sync-audio requires a video asset');
  }
  const assetId = stripAt(assetValue.trim());
  if (!assetId.startsWith('vid-')) throw new Error('/sync-audio requires a vid-* asset');
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

export function normalizeTrimCommandArgs(
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

export function normalizeApplyCutsCommandArgs(
  args: Readonly<Record<string, unknown>>,
): { asset_id: string; cuts: Array<{ cut_start: number; cut_end: number }> } {
  const assetValue = args.asset_id;
  if (typeof assetValue !== 'string' || !assetValue.trim()) {
    throw new Error('/apply-cuts requires a video asset');
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

export function normalizeTranslateSubtitlesCommandArgs(
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

export type CommandAdapterFn = (args: Readonly<Record<string, unknown>>) => CommandToolArgs;

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
    if ('speed' in result) {
      const val = result.speed;
      delete result.speed;
      if (typeof val === 'string' && val.endsWith('s')) {
        result.target_duration_seconds = parseFloat(val);
      } else if (val !== undefined) {
        result.speed = parseFloat(String(val));
      }
    }
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

export type CommandAdapterName = keyof typeof COMMAND_ADAPTERS;

export function adaptCommandArgs(
  adapterName: string | undefined,
  _toolName: string,
  args: Readonly<Record<string, unknown>>,
): CommandToolArgs {
  if (!adapterName) return args as CommandToolArgs;
  const adapterFn = COMMAND_ADAPTERS[adapterName as CommandAdapterName];
  if (!adapterFn) throw new Error(`Unknown command adapter: ${adapterName}`);
  return adapterFn(args);
}

function parseNumberToken(token: string): string | number {
  const stripped = stripAt(token);
  const parsed = Number(stripped);
  return Number.isFinite(parsed) ? parsed : stripped;
}

function parseBooleanToken(token: string): string | boolean {
  const stripped = stripAt(token).toLowerCase();
  if (['true', '1', 'yes', 'y', 'on', 'full', 'fix'].includes(stripped)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(stripped)) return false;
  return stripAt(token);
}

function parseTokenValue(token: string, param: CommandParam): CommandArgValue {
  if (param.type === 'number') return parseNumberToken(token);
  if (param.type === 'boolean') return parseBooleanToken(token);
  return stripAt(token);
}

export function parseCommandArgs(rest: string, params: CommandParam[]): Record<string, CommandArgValue> {
  if (!rest || params.length === 0) return {};

  const tokens = rest.split(/\s+/);
  const args: Record<string, CommandArgValue> = {};
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
    } else if (isLast && param.type === 'string') {
      // Last string param gets all remaining tokens joined.
      // Strip leading "to" connector (e.g. "/rename @slug to new-name")
      let remaining = tokens.slice(i, tokenLimit);
      if (remaining.length > 1 && remaining[0].toLowerCase() === 'to') {
        remaining = remaining.slice(1);
      }
      const raw = remaining.join(' ');
      args[param.name] = stripAt(raw);
    } else {
      args[param.name] = parseTokenValue(tokens[i], param);
    }
  }

  return args;
}

export function selectCommandForInput(commands: ServerCommand[], commandStr: string, rest: string): ServerCommand | undefined {
  const exactMatches = commands.filter((command) => command.command === commandStr);
  const matches = exactMatches.length > 0
    ? exactMatches
    : commands.filter((command) => command.aliases?.includes(commandStr));
  if (matches.length <= 1) return matches[0];

  const firstToken = rest.split(/\s+/).find(Boolean) ?? '';
  const firstParam = (cmd: ServerCommand) => cmd.params[0]?.name ?? '';
  const takesAssetFirst = (cmd: ServerCommand) => /asset|slug|source/.test(firstParam(cmd));

  if (firstToken.startsWith('@')) {
    return matches.find(takesAssetFirst) ?? matches[0];
  }

  return matches.find((cmd) => !takesAssetFirst(cmd)) ?? matches[0];
}
