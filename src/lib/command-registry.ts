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

export type CommandToolArgValue = CommandArgValue | SyncAudioAnchor[];
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
  mcpTool?: { tool: string; autoInject?: string[]; injectParams?: Record<string, string | number | boolean> };
  uiAction?: string;
  onMount?: string[];
}

export type CommandDescriptor = ServerCommand;

export interface QrOutroCommandArgs {
  qr_image_slugs: string[];
  sound_effect_slug?: string;
  aspect_ratio?: '16:9' | '9:16' | '1:1';
}

export interface TimewarpCommandArgs {
  asset_id: string;
  start_seconds: number;
  end_seconds: number;
  stretch_factor: number;
}

export function filterCommandsByMountKeys(
  commands: ServerCommand[],
  activeKeys: ReadonlySet<string>,
): ServerCommand[] {
  return commands.filter((cmd) => {
    if (!cmd.onMount || cmd.onMount.length === 0) return true;
    return cmd.onMount.every((key) => activeKeys.has(key));
  });
}

const stripAt = (token: string): string => (token.startsWith('@') ? token.slice(1) : token);

export function normalizeQrOutroCommandArgs(tokens: readonly string[]): QrOutroCommandArgs {
  const inputs = tokens.map(stripAt);
  const qrImages: string[] = [];
  let soundEffect: string | undefined;
  let aspectRatio: QrOutroCommandArgs['aspect_ratio'];

  for (const token of inputs) {
    if (token.startsWith('img-')) {
      qrImages.push(token);
      if (qrImages.length > 4) {
        throw new Error('/qr-outro accepts at most 4 QR images');
      }
      continue;
    }
    if (token.startsWith('aud-')) {
      if (soundEffect) throw new Error('/qr-outro accepts only one sound effect');
      soundEffect = token;
      continue;
    }
    if (token === '16:9' || token === '9:16' || token === '1:1') {
      if (aspectRatio) throw new Error('/qr-outro accepts only one aspect ratio');
      aspectRatio = token;
      continue;
    }
    throw new Error(`Unrecognized /qr-outro input: ${token}`);
  }

  if (qrImages.length === 0) {
    throw new Error('/qr-outro requires at least one QR img-* asset');
  }

  return {
    qr_image_slugs: qrImages,
    ...(soundEffect ? { sound_effect_slug: soundEffect } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
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
  const matches = commands.filter((c) => c.command === commandStr);
  if (matches.length <= 1) return matches[0];

  const firstToken = rest.split(/\s+/).find(Boolean) ?? '';
  const firstParam = (cmd: ServerCommand) => cmd.params[0]?.name ?? '';
  const takesAssetFirst = (cmd: ServerCommand) => /asset|slug|source/.test(firstParam(cmd));

  if (firstToken.startsWith('@')) {
    return matches.find(takesAssetFirst) ?? matches[0];
  }

  return matches.find((cmd) => !takesAssetFirst(cmd)) ?? matches[0];
}
