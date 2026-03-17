import { cn } from '@/lib/utils';
import { Check, Zap } from 'lucide-react';
import { CommandButton } from '@/components/commands';
import type { ExecuteButtonState } from '@/components/commands/types';
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
  textColor?: string;
  highlightColor?: string;
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

  onApply?: () => void;
  applyState?: ExecuteButtonState;
}

// ── Orientation constants ──

const orientationShortLabels: Record<Orientation, string> = {
  landscape: '16:9',
  portrait: '9:16',
  square: '1:1',
};

// ── Helper sub-components ──

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-primary/20 bg-black/50 rounded-lg p-2 space-y-2">
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

function ColorSwatch({ value, onChange }: { value: string; onChange?: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-4 h-4 rounded border border-white/10 bg-transparent cursor-pointer [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
      />
      <span className="text-[9px] font-mono text-foreground/50">{value}</span>
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
  textColor = '#F8FAFC',
  highlightColor = '#991B1B',
  onSubtitleChange,
  audioVolume,
  audioFadeIn,
  audioFadeOut,
  osgEnabled,
  osgPosition,
  onOsgChange,
  backgroundMode,
  onBackgroundChange,
  onApply,
  applyState,
}: RenderSettingsPanelProps) {
  return (
    <div className="relative p-2 flex flex-col gap-1.5 h-full">
      {/* Grid overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(var(--color-primary) 1px, transparent 1px), linear-gradient(90deg, var(--color-primary) 1px, transparent 1px)',
          backgroundSize: '12px 12px',
        }}
      />

      {/* Corner brackets */}
      <div className="absolute top-1 left-1 w-3 h-3 border-l border-t border-primary/25" />
      <div className="absolute top-1 right-1 w-3 h-3 border-r border-t border-primary/25" />
      <div className="absolute bottom-1 left-1 w-3 h-3 border-l border-b border-primary/25" />
      <div className="absolute bottom-1 right-1 w-3 h-3 border-r border-b border-primary/25" />

      {/* Orientations — segmented control */}
      <div className="flex h-6 rounded border border-white/10 overflow-hidden">
        {orientations.map((o, i) => (
          <button
            key={o.orient}
            onClick={() => onOrientationClick?.(o.orient)}
            disabled={o.rendering}
            className={cn(
              'flex-1 flex items-center justify-center gap-1 font-mono text-[10px] font-bold transition-colors',
              i > 0 && 'border-l border-white/10',
              o.active
                ? 'bg-primary/15 text-primary shadow-[inset_0_0_12px_var(--color-primary)/10]'
                : 'bg-transparent text-muted-foreground hover:bg-white/5',
              o.rendering && 'opacity-50',
            )}
          >
            <span>{orientationShortLabels[o.orient]}</span>
            {o.rendered && o.active && <Check className="w-3 h-3 text-primary" />}
            <span
              className={cn(
                'w-1.5 h-1.5 rounded-full shrink-0',
                o.rendering ? 'bg-primary animate-pulse' : o.rendered ? 'bg-primary' : 'bg-muted-foreground/20',
              )}
            />
          </button>
        ))}
      </div>

      {/* Settings in 2 columns */}
      <div className="grid grid-cols-2 gap-1.5 items-start">
        {/* Left column: Subtitles */}
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
                { label: 'S', value: 'small' },
                { label: 'M', value: 'medium' },
                { label: 'L', value: 'large' },
              ]}
              value={fontSize}
              onChange={(v) => onSubtitleChange?.('fontSize', v)}
            />
          </SettingRow>
          <SettingRow label="Text Color">
            <ColorSwatch value={textColor} onChange={(v) => onSubtitleChange?.('textColor', v)} />
          </SettingRow>
          <SettingRow label="Highlight">
            <ColorSwatch value={highlightColor} onChange={(v) => onSubtitleChange?.('highlightColor', v)} />
          </SettingRow>
        </SettingsSection>

        {/* Right column: Audio + OSG + Background */}
        <div className="space-y-1.5">
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
      </div>

      {/* Spacer + Apply button bottom-right */}
      <div className="flex-1" />
      <div className="flex justify-end">
        <CommandButton
          command="/render"
          icon={<Zap className="w-5 h-5" />}
          size="lg"
          state={applyState}
          onClick={onApply}
        />
      </div>
    </div>
  );
}
