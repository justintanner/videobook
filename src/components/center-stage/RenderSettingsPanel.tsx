import { cn } from '@/lib/utils';
import { Check, Zap, Type, Volume2, Tv, ImageIcon, Monitor, Smartphone, Square } from 'lucide-react';
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

const orientationIcons: Record<Orientation, React.ReactNode> = {
  landscape: <Monitor className="w-3 h-3" />,
  portrait: <Smartphone className="w-3 h-3" />,
  square: <Square className="w-3 h-3" />,
};

// ── Helper sub-components ──

function SettingsSection({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800/60 rounded p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        {icon && <span className="text-primary/60">{icon}</span>}
        <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">{title}</span>
      </div>
      {children}
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-mono text-muted-foreground">{label}</span>
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
            'px-2.5 py-1 rounded border text-[11px] font-mono font-bold',
            opt.value === value
              ? 'bg-primary/10 border-primary/50 text-primary'
              : 'bg-black/40 border-zinc-800/60 text-muted-foreground hover:bg-white/5',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange?: (value: T) => void;
}) {
  return (
    <div className="flex rounded border border-zinc-800/60 overflow-hidden">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          onClick={() => onChange?.(opt.value)}
          className={cn(
            'flex-1 px-2.5 py-1 text-[11px] font-mono font-bold',
            i > 0 && 'border-l border-zinc-800/60',
            opt.value === value
              ? 'bg-primary/10 text-primary'
              : 'bg-black/40 text-muted-foreground hover:bg-white/5',
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
            'px-2.5 py-1 rounded border text-[11px] font-mono font-bold text-center',
            opt.value === value
              ? 'bg-primary/10 border-primary/50 text-primary'
              : 'bg-black/40 border-zinc-800/60 text-muted-foreground hover:bg-white/5',
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
    <div className="w-[72px] px-2 py-1 rounded border border-zinc-800/60 bg-black/40 flex items-center justify-end gap-1">
      <span className="text-xs font-mono font-bold text-foreground/80">{value}</span>
      {unit && <span className="text-[9px] font-mono text-muted-foreground/50">{unit}</span>}
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
        className="w-4 h-4 rounded border border-zinc-800/60 bg-transparent cursor-pointer [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
      />
      <span className="text-[9px] font-mono text-muted-foreground/50">{value}</span>
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
    <div className="p-4 flex flex-col gap-3 h-full">
      {/* Scrollable content area */}
      <div className="flex-1 overflow-auto space-y-3 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {/* OUTPUT FORMAT label + Orientations */}
        <div className="space-y-1.5">
          <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground">Output Format</span>
          <div className="flex h-8 rounded border border-zinc-800/60 overflow-hidden">
            {orientations.map((o, i) => (
              <button
                key={o.orient}
                onClick={() => onOrientationClick?.(o.orient)}
                disabled={o.rendering}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 font-mono text-[11px] font-bold',
                  i > 0 && 'border-l border-zinc-800/60',
                  o.active
                    ? 'bg-primary/10 text-primary'
                    : 'bg-black/40 text-muted-foreground hover:bg-white/5',
                  o.rendering && 'opacity-50',
                )}
              >
                {orientationIcons[o.orient]}
                <span>{orientationShortLabels[o.orient]}</span>
                {o.rendered && o.active && <Check className="w-3 h-3 text-primary" />}
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full shrink-0',
                    o.rendered ? 'bg-primary' : 'bg-muted-foreground/20',
                  )}
                />
              </button>
            ))}
          </div>
        </div>

        {/* Settings in 2 columns */}
        <div className="grid grid-cols-2 gap-3 items-start">
          {/* Left column: Subtitles */}
          <SettingsSection title="Subtitles" icon={<Type className="w-3.5 h-3.5" />}>
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
            <SegmentedControl
              options={[
                { label: 'TikDance', value: 'tikdance' },
                { label: 'Highlight', value: 'highlight' },
              ]}
              value={subtitleStyle}
              onChange={(v) => onSubtitleChange?.('style', v)}
            />
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
            {/* Mini subtitle preview */}
            <div className="h-6 flex items-center justify-center rounded bg-black/60 border border-zinc-800/60">
              <span
                className="text-[11px] font-bold font-mono"
                style={{
                  color: textColor,
                  backgroundColor: subtitleStyle === 'highlight' ? highlightColor : 'transparent',
                  padding: subtitleStyle === 'highlight' ? '0 4px' : undefined,
                  borderRadius: subtitleStyle === 'highlight' ? '2px' : undefined,
                }}
              >
                TikDance
              </span>
            </div>
          </SettingsSection>

          {/* Right column: Audio + OSG + Background */}
          <div className="space-y-3">
            <SettingsSection title="Audio" icon={<Volume2 className="w-3.5 h-3.5" />}>
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

            <SettingsSection title="OSG" icon={<Tv className="w-3.5 h-3.5" />}>
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

            <SettingsSection title="Background" icon={<ImageIcon className="w-3.5 h-3.5" />}>
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
      </div>

      {/* Docked action bar */}
      <div className="shrink-0 flex items-center justify-end pt-3 border-t border-zinc-800/60">
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
