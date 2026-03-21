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
    <div className="relative bg-[#071017] p-3 space-y-2.5">
      {/* Radial glow behind title */}
      <div className="absolute top-0 left-0 right-0 h-8 bg-[radial-gradient(ellipse_at_left,rgba(0,212,255,0.06)_0%,transparent_70%)] pointer-events-none" />
      <div className="flex items-center gap-2 relative">
        {icon && <span className="text-primary/60">{icon}</span>}
        <span className="text-sm font-mono font-bold uppercase tracking-[0.15em] text-primary/80">{title}</span>
      </div>
      {children}
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] font-mono font-medium text-[#A9B7C6]">{label}</span>
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
            'px-3 py-1.5 rounded border font-mono',
            opt.value === value
              ? 'text-[13px] font-semibold bg-[#00CFFF]/20 border-[#00CFFF]/60 text-[#00CFFF] shadow-[inset_0_1px_4px_rgba(0,207,255,0.3),0_0_8px_rgba(0,207,255,0.15)]'
              : 'text-[11px] font-bold bg-[#11161C] border-[#22303A] text-muted-foreground hover:border-primary/30',
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
    <div className="flex rounded border border-[#22303A] overflow-hidden">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          onClick={() => onChange?.(opt.value)}
          className={cn(
            'flex-1 px-3 py-1.5 font-mono transition-colors',
            i > 0 && 'border-l border-[#22303A]',
            opt.value === value
              ? 'text-[13px] font-semibold bg-[#00CFFF]/20 text-[#00CFFF] shadow-[inset_0_1px_4px_rgba(0,207,255,0.3),0_0_8px_rgba(0,207,255,0.15)]'
              : 'text-[11px] font-bold bg-[#11161C] text-muted-foreground hover:border-primary/30',
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
            'px-3 py-1.5 rounded border font-mono text-center',
            opt.value === value
              ? 'text-[13px] font-semibold bg-[#00CFFF]/20 border-[#00CFFF]/60 text-[#00CFFF] shadow-[inset_0_1px_4px_rgba(0,207,255,0.3),0_0_8px_rgba(0,207,255,0.15)]'
              : 'text-[11px] font-bold bg-[#11161C] border-[#22303A] text-muted-foreground hover:border-primary/30',
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
    <div className="w-[72px] px-2 py-1 rounded border border-white/10 bg-black/40 flex items-center justify-end gap-1">
      <span className="text-[13px] font-mono font-semibold text-foreground/80">{value}</span>
      {unit && <span className="text-[9px] font-mono text-muted-foreground/50 bg-white/5 px-1 py-0.5 rounded">{unit}</span>}
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
        className="w-4 h-4 rounded border border-white/10 bg-transparent cursor-pointer hover:ring-1 hover:ring-white [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
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
    <div className="relative p-4 flex flex-col gap-3 h-full">
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

      {/* Scrollable content area */}
      <div className="flex-1 overflow-auto space-y-3 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {/* OUTPUT FORMAT label + Orientations */}
        <div className="space-y-1.5">
          <span className="text-[10px] font-mono font-bold uppercase tracking-[0.15em] text-primary/60">Output Format</span>
          <div className="flex h-8 rounded border border-[#22303A] overflow-hidden">
            {orientations.map((o, i) => (
              <button
                key={o.orient}
                onClick={() => onOrientationClick?.(o.orient)}
                disabled={o.rendering}
                className={cn(
                  'relative flex-1 flex items-center justify-center gap-1.5 font-mono text-[11px] font-bold transition-colors overflow-hidden',
                  i > 0 && 'border-l border-[#22303A]',
                  o.active
                    ? 'bg-[#00CFFF]/20 text-[#00CFFF] shadow-[inset_0_1px_4px_rgba(0,207,255,0.3),0_0_8px_rgba(0,207,255,0.15)]'
                    : 'bg-[#11161C] text-muted-foreground hover:border-primary/30',
                  o.rendering && 'opacity-50',
                )}
              >
                {/* Scanline overlay for active segment */}
                {o.active && (
                  <div className="absolute inset-0 bg-[linear-gradient(transparent_50%,rgba(0,255,255,0.05)_50%)] bg-[length:100%_4px] animate-cyber-scanline pointer-events-none" />
                )}
                <span className="relative">{orientationIcons[o.orient]}</span>
                <span className="relative">{orientationShortLabels[o.orient]}</span>
                {o.rendered && o.active && <Check className="w-3 h-3 text-[#00CFFF] relative" />}
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full shrink-0 relative',
                    o.rendering ? 'bg-primary animate-pulse' : o.rendered ? 'bg-primary' : 'bg-muted-foreground/20',
                  )}
                />
              </button>
            ))}
          </div>
        </div>

        {/* Settings in 2 columns */}
        <div className="grid grid-cols-2 gap-6 items-start">
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
            <div className="h-6 flex items-center justify-center rounded bg-black/60 border border-white/5">
              <span
                className="text-[11px] font-bold font-mono"
                style={{
                  color: textColor,
                  textShadow: `0 0 8px ${highlightColor}`,
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
      <div className="h-[2px] bg-primary/20" />
      <div className="h-16 shrink-0 flex items-center justify-end px-4 border-t border-primary/15 bg-[#071017]/80">
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
