export interface RenderSettings {
  subtitlesEnabled: boolean;
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
  backgroundMode: 'blur' | 'black';
  strokeWidth: number;
  strokeColor: string;
  shadowBlur: number;
  shadowOpacity: number;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  subtitlesEnabled: true,
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
  backgroundMode: 'blur',
  strokeWidth: 6,
  strokeColor: '#000000',
  shadowBlur: 6,
  shadowOpacity: 60,
};

function extractAssetId(osgImagePath: string | undefined | null): string | null {
  if (!osgImagePath) return null;
  // Path format: .../img-something/original.png — extract the asset ID directory name
  const parts = osgImagePath.split('/');
  const imgPart = parts.find((p) => p.startsWith('img-'));
  return imgPart ?? null;
}

function migrateStyle(raw: string | undefined): RenderSettings['subtitleStyle'] | undefined {
  if (!raw) return undefined;
  if (raw === 'tikdance') return 'impact';
  if (raw === 'impact' || raw === 'highlight') return raw;
  return undefined;
}

export function getDefaultRenderSettings(orientation: string): RenderSettings {
  if (orientation === 'portrait') {
    return { ...DEFAULT_RENDER_SETTINGS, subtitleStyle: 'impact', textColor: '#FFFFFF', highlightColor: '#FFFF00' };
  }
  return { ...DEFAULT_RENDER_SETTINGS, subtitleStyle: 'highlight', textColor: '#FFFFFF', highlightColor: '#991B1B' };
}

export function storedToRenderSettings(stored: Record<string, unknown>): RenderSettings {
  return {
    subtitlesEnabled: (stored.subtitlesEnabled as boolean | undefined) ?? DEFAULT_RENDER_SETTINGS.subtitlesEnabled,
    subtitleStyle: migrateStyle(stored.highlightStyle as string | undefined) ?? DEFAULT_RENDER_SETTINGS.subtitleStyle,
    subtitlePosition: (stored.position as RenderSettings['subtitlePosition'] | undefined) ?? DEFAULT_RENDER_SETTINGS.subtitlePosition,
    fontSize: (stored.fontSize as RenderSettings['fontSize'] | undefined) ?? DEFAULT_RENDER_SETTINGS.fontSize,
    textColor: (stored.textColor as string | undefined) ?? DEFAULT_RENDER_SETTINGS.textColor,
    highlightColor: (stored.highlightColor as string | undefined) ?? DEFAULT_RENDER_SETTINGS.highlightColor,
    audioVolume: (stored.audioVolume as number | undefined) ?? DEFAULT_RENDER_SETTINGS.audioVolume,
    audioFadeIn: (stored.audioFadeIn as number | undefined) ?? DEFAULT_RENDER_SETTINGS.audioFadeIn,
    audioFadeOut: (stored.audioFadeOut as number | undefined) ?? DEFAULT_RENDER_SETTINGS.audioFadeOut,
    osgAssetId: (stored.osgAssetId as string | undefined) ?? extractAssetId(stored.osgImagePath as string | undefined),
    osgAssetSrc: null, // frontend resolves src from asset list
    osgPosition: (stored.osgPosition as RenderSettings['osgPosition'] | undefined) ?? DEFAULT_RENDER_SETTINGS.osgPosition,
    backgroundMode: (stored.backgroundMode as RenderSettings['backgroundMode'] | undefined) ?? DEFAULT_RENDER_SETTINGS.backgroundMode,
    strokeWidth: (stored.strokeWidth as number | undefined) ?? DEFAULT_RENDER_SETTINGS.strokeWidth,
    strokeColor: (stored.strokeColor as string | undefined) ?? DEFAULT_RENDER_SETTINGS.strokeColor,
    shadowBlur: (stored.shadowBlur as number | undefined) ?? DEFAULT_RENDER_SETTINGS.shadowBlur,
    shadowOpacity: (stored.shadowOpacity as number | undefined) ?? DEFAULT_RENDER_SETTINGS.shadowOpacity,
  };
}
