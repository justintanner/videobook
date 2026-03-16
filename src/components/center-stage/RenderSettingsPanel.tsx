import { cn } from '@/lib/utils';
import { Monitor, Smartphone, Square, Check } from 'lucide-react';
import type { Orientation } from '@/hooks/useTimeline';

// ── Types ──

export interface OrientationEntry {
  orient: Orientation;
  active: boolean;
  rendered: boolean;
  rendering: boolean;
}

export interface RenderSettingsPanelProps {
  orientations: OrientationEntry[];
  onOrientationClick?: (orient: Orientation) => void;

  subtitlesEnabled: boolean;
  subtitleStyle: 'tikdance' | 'highlight';
  subtitlePosition: 'top' | 'middle' | 'bottom';
  fontSize: 'small' | 'medium' | 'large';
  onSubtitleChange?: (field: string, value: string | boolean) => void;

  audioVolume: number;
  audioFadeIn: number;
  audioFadeOut: number;
  onAudioChange?: (field: string, value: number) => void;

  osgEnabled: boolean;
  osgPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  onOsgChange?: (field: string, value: string | boolean) => void;

  backgroundMode: 'blur' | 'black';
  onBackgroundChange?: (mode: 'blur' | 'black') => void;
}

// ── Orientation constants ──

const orientationLabels: Record<Orientation, string> = {
  landscape: '/landscape 1920x1080',
  portrait: '/portrait 1080x1920',
  square: '/square 1080x1080',
};

const ratioIcons: Record<Orientation, typeof Monitor> = {
  landscape: Monitor,
  portrait: Smartphone,
  square: Square,
};

// ── Helper sub-components ──

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-primary/20 bg-black/50 rounded-lg p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <div className="w-0.5 h-3 bg-primary/50 rounded-full" />
        <span className="text-xs font-mono font-bold uppercase tracking-[0.15em]">{title}</span>
      </div>
      {children}
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] font-mono text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ToggleGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange?: (value: T) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange?.(opt.value)}
          className={cn(
            'px-2.5 py-1 rounded border text-[10px] font-mono font-bold',
            opt.value === value
              ? 'bg-primary/20 border-primary/50 text-primary'
              : 'bg-black/40 border-white/10 text-muted-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ToggleGrid<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange?: (value: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange?.(opt.value)}
          className={cn(
            'px-2.5 py-1 rounded border text-[10px] font-mono font-bold text-center',
            opt.value === value
              ? 'bg-primary/20 border-primary/50 text-primary'
              : 'bg-black/40 border-white/10 text-muted-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function NumberDisplay({ value, unit }: { value: number; unit?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-16 px-2 py-1 rounded border border-white/10 bg-black/40 text-[10px] font-mono font-bold text-foreground/80 text-right">
        {value}
      </span>
      {unit && <span className="text-[10px] font-mono text-muted-foreground/50">{unit}</span>}
    </div>
  );
}

// ── Main component ──

export function RenderSettingsPanel({
  orientations,
  onOrientationClick,
  subtitlesEnabled,
  subtitleStyle,
  subtitlePosition,
  fontSize,
  onSubtitleChange,
  audioVolume,
  audioFadeIn,
  audioFadeOut,
  osgEnabled,
  osgPosition,
  onOsgChange,
  backgroundMode,
  onBackgroundChange,
}: RenderSettingsPanelProps) {
  return (
    <div className="p-4 space-y-3">
      {/* Orientations */}
      <SettingsSection title="Orientations">
        {orientations.map((o) => {
          const Icon = ratioIcons[o.orient];
          return (
            <button
              key={o.orient}
              onClick={() => onOrientationClick?.(o.orient)}
              disabled={o.rendering}
              className={cn(
                'w-full flex items-center gap-3 px-4 py-3 rounded border text-left font-mono text-xs',
                o.active
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-zinc-800/60 bg-black/40 text-muted-foreground',
                o.rendering && 'opacity-50',
              )}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="font-bold tracking-wider flex-1">{orientationLabels[o.orient]}</span>
              <span
                className={cn(
                  'w-1.5 h-1.5 rounded-full',
                  o.rendering ? 'bg-primary animate-pulse' : o.rendered ? 'bg-primary' : 'bg-muted-foreground/20',
                )}
              />
              {o.rendered && o.active && <Check className="w-3.5 h-3.5 text-primary" />}
              {o.rendering && (
                <span className="text-[10px] font-bold tracking-widest text-primary animate-pulse">RENDERING</span>
              )}
              {!o.rendered && !o.rendering && (
                <span className="text-[10px] font-bold tracking-widest text-muted-foreground/40">RENDER</span>
              )}
            </button>
          );
        })}
      </SettingsSection>

      {/* Subtitles */}
      <SettingsSection title="Subtitles">
        <SettingRow label="Enabled">
          <ToggleGroup
            options={[
              { label: 'ON', value: 'on' },
              { label: 'OFF', value: 'off' },
            ]}
            value={subtitlesEnabled ? 'on' : 'off'}
            onChange={(v) => onSubtitleChange?.('enabled', v === 'on')}
          />
        </SettingRow>
        <SettingRow label="Style">
          <ToggleGroup
            options={[
              { label: 'TikDance', value: 'tikdance' },
              { label: 'Highlight', value: 'highlight' },
            ]}
            value={subtitleStyle}
            onChange={(v) => onSubtitleChange?.('style', v)}
          />
        </SettingRow>
        <SettingRow label="Position">
          <ToggleGroup
            options={[
              { label: 'Top', value: 'top' },
              { label: 'Mid', value: 'middle' },
              { label: 'Bottom', value: 'bottom' },
            ]}
            value={subtitlePosition}
            onChange={(v) => onSubtitleChange?.('position', v)}
          />
        </SettingRow>
        <SettingRow label="Font Size">
          <ToggleGroup
            options={[
              { label: 'Small', value: 'small' },
              { label: 'Medium', value: 'medium' },
              { label: 'Large', value: 'large' },
            ]}
            value={fontSize}
            onChange={(v) => onSubtitleChange?.('fontSize', v)}
          />
        </SettingRow>
      </SettingsSection>

      {/* Audio */}
      <SettingsSection title="Audio">
        <SettingRow label="Volume">
          <NumberDisplay value={audioVolume} />
        </SettingRow>
        <SettingRow label="Fade In">
          <NumberDisplay value={audioFadeIn} unit="ms" />
        </SettingRow>
        <SettingRow label="Fade Out">
          <NumberDisplay value={audioFadeOut} unit="ms" />
        </SettingRow>
      </SettingsSection>

      {/* OSG */}
      <SettingsSection title="OSG">
        <SettingRow label="Enabled">
          <ToggleGroup
            options={[
              { label: 'ON', value: 'on' },
              { label: 'OFF', value: 'off' },
            ]}
            value={osgEnabled ? 'on' : 'off'}
            onChange={(v) => onOsgChange?.('enabled', v === 'on')}
          />
        </SettingRow>
        <SettingRow label="Position">
          <ToggleGrid
            options={[
              { label: 'TL', value: 'top-left' },
              { label: 'TR', value: 'top-right' },
              { label: 'BL', value: 'bottom-left' },
              { label: 'BR', value: 'bottom-right' },
            ]}
            value={osgPosition}
            onChange={(v) => onOsgChange?.('position', v)}
          />
        </SettingRow>
      </SettingsSection>

      {/* Background */}
      <SettingsSection title="Background">
        <ToggleGroup
          options={[
            { label: 'Blur', value: 'blur' },
            { label: 'Black', value: 'black' },
          ]}
          value={backgroundMode}
          onChange={onBackgroundChange}
        />
      </SettingsSection>
    </div>
  );
}
