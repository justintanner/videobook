export interface RenderSettings {
  subtitlesEnabled: boolean;
  subtitleLanguage: string;
  subtitleStyle: 'impact' | 'highlight';
  subtitlePosition: 'top' | 'middle' | 'bottom';
  fontSize: 'small' | 'medium' | 'large';
  textColor: string;
  highlightColor: string;
  audioVolume: number;
  audioFadeIn: number;
  audioFadeOut: number;
  osgAssetId: string | null;
  osgAssetSrc: string | null;
  osgPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  osgSize: 'small' | 'medium' | 'large';
  backgroundMode: 'blur' | 'black';
  strokeWidth: number;
  strokeColor: string;
  shadowBlur: number;
  shadowOpacity: number;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  subtitlesEnabled: true,
  subtitleLanguage: 'original',
  subtitleStyle: 'impact',
  subtitlePosition: 'bottom',
  fontSize: 'medium',
  textColor: '#F8FAFC',
  highlightColor: '#991B1B',
  audioVolume: 100,
  audioFadeIn: 150,
  audioFadeOut: 100,
  osgAssetId: null,
  osgAssetSrc: null,
  osgPosition: 'top-right',
  osgSize: 'medium',
  backgroundMode: 'blur',
  strokeWidth: 6,
  strokeColor: '#000000',
  shadowBlur: 6,
  shadowOpacity: 60,
};

// Subtitle language: 'original' (source transcript) or an ISO 639-1 code.
export function isSubtitleLanguage(value: unknown): value is string {
  return typeof value === 'string' && (value === 'original' || /^[a-z]{2}$/.test(value));
}

// Curated targets offered in the /subs language dropdown.
export const SUBTITLE_LANGUAGES: string[] = ['en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'tr', 'ar', 'hi', 'id', 'ja', 'ko', 'zh'];

// ElevenLabs reports the detected source language in ISO 639-3; map common
// codes to the ISO 639-1 codes the language setting uses.
const ISO3_TO_ISO1: Record<string, string> = {
  eng: 'en', zho: 'zh', cmn: 'zh', yue: 'zh', spa: 'es', por: 'pt', fra: 'fr',
  deu: 'de', ita: 'it', nld: 'nl', pol: 'pl', rus: 'ru', tur: 'tr', ara: 'ar',
  hin: 'hi', ind: 'id', jpn: 'ja', kor: 'ko', vie: 'vi', tha: 'th', ukr: 'uk',
};

export interface TranscriptInfo {
  sourceLanguageCode: string | null;
  sourceLanguage: string | null;
  cachedTranslations: string[];
}

export function sourceLanguageLabel(info: TranscriptInfo | null): string | null {
  if (!info) return null;
  const iso1 = info.sourceLanguage
    ?? (info.sourceLanguageCode ? ISO3_TO_ISO1[info.sourceLanguageCode.toLowerCase()] ?? null : null);
  if (iso1) return iso1.toUpperCase();
  return info.sourceLanguageCode ? info.sourceLanguageCode.toUpperCase() : null;
}

function extractAssetId(osgImagePath: string | undefined | null): string | null {
  if (!osgImagePath) return null;
  // Path format: .../img-something/original.png — extract the asset ID directory name
  const parts = osgImagePath.split('/');
  const imgPart = parts.find((p) => p.startsWith('img-'));
  return imgPart ?? null;
}

export function getDefaultRenderSettings(orientation: string): RenderSettings {
  if (orientation === 'portrait') {
    return { ...DEFAULT_RENDER_SETTINGS, subtitleStyle: 'impact', textColor: '#FFFFFF', highlightColor: '#FFFF00' };
  }
  return { ...DEFAULT_RENDER_SETTINGS, subtitleStyle: 'highlight', textColor: '#FFFFFF', highlightColor: '#991B1B' };
}

// `resolveOsgSrc` maps a stored OSG asset id to a displayable image src (e.g. the
// asset's filePath from the loaded media list). Without it, osgAssetSrc stays null
// and the drop zone shows its empty placeholder even when an OSG asset is applied.
export function storedToRenderSettings(
  stored: Record<string, unknown>,
  resolveOsgSrc?: (assetId: string) => string | null,
): RenderSettings {
  const osgAssetId = (stored.osgAssetId as string | undefined) ?? extractAssetId(stored.osgImagePath as string | undefined);
  return {
    subtitlesEnabled: (stored.subtitlesEnabled as boolean | undefined) ?? DEFAULT_RENDER_SETTINGS.subtitlesEnabled,
    subtitleLanguage: isSubtitleLanguage(stored.subtitleLanguage) ? stored.subtitleLanguage : DEFAULT_RENDER_SETTINGS.subtitleLanguage,
    subtitleStyle: (stored.highlightStyle as RenderSettings['subtitleStyle'] | undefined) ?? DEFAULT_RENDER_SETTINGS.subtitleStyle,
    subtitlePosition: (stored.position as RenderSettings['subtitlePosition'] | undefined) ?? DEFAULT_RENDER_SETTINGS.subtitlePosition,
    fontSize: (stored.fontSize as RenderSettings['fontSize'] | undefined) ?? DEFAULT_RENDER_SETTINGS.fontSize,
    textColor: (stored.textColor as string | undefined) ?? DEFAULT_RENDER_SETTINGS.textColor,
    highlightColor: (stored.highlightColor as string | undefined) ?? DEFAULT_RENDER_SETTINGS.highlightColor,
    audioVolume: (stored.audioVolume as number | undefined) ?? DEFAULT_RENDER_SETTINGS.audioVolume,
    audioFadeIn: (stored.audioFadeIn as number | undefined) ?? DEFAULT_RENDER_SETTINGS.audioFadeIn,
    audioFadeOut: (stored.audioFadeOut as number | undefined) ?? DEFAULT_RENDER_SETTINGS.audioFadeOut,
    osgAssetId,
    osgAssetSrc: osgAssetId ? (resolveOsgSrc?.(osgAssetId) ?? null) : null,
    osgPosition: (stored.osgPosition as RenderSettings['osgPosition'] | undefined) ?? DEFAULT_RENDER_SETTINGS.osgPosition,
    osgSize: (stored.osgSize as RenderSettings['osgSize'] | undefined) ?? DEFAULT_RENDER_SETTINGS.osgSize,
    backgroundMode: (stored.backgroundMode as RenderSettings['backgroundMode'] | undefined) ?? DEFAULT_RENDER_SETTINGS.backgroundMode,
    strokeWidth: (stored.strokeWidth as number | undefined) ?? DEFAULT_RENDER_SETTINGS.strokeWidth,
    strokeColor: (stored.strokeColor as string | undefined) ?? DEFAULT_RENDER_SETTINGS.strokeColor,
    shadowBlur: (stored.shadowBlur as number | undefined) ?? DEFAULT_RENDER_SETTINGS.shadowBlur,
    shadowOpacity: (stored.shadowOpacity as number | undefined) ?? DEFAULT_RENDER_SETTINGS.shadowOpacity,
  };
}
