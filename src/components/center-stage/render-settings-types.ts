export interface RenderSettings {
  subtitlesEnabled: boolean;
  subtitleStyle: 'tikdance' | 'highlight';
  subtitlePosition: 'top' | 'middle' | 'bottom';
  fontSize: 'small' | 'medium' | 'large';
  textColor: string;
  highlightColor: string;
  audioVolume: number;
  audioFadeIn: number;
  audioFadeOut: number;
  osgEnabled: boolean;
  osgPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  backgroundMode: 'blur' | 'black';
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  subtitlesEnabled: true,
  subtitleStyle: 'tikdance',
  subtitlePosition: 'bottom',
  fontSize: 'medium',
  textColor: '#F8FAFC',
  highlightColor: '#991B1B',
  audioVolume: 100,
  audioFadeIn: 150,
  audioFadeOut: 100,
  osgEnabled: true,
  osgPosition: 'top-right',
  backgroundMode: 'blur',
};
