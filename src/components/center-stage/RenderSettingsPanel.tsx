import { cn } from '@/lib/utils';
import { Monitor, Smartphone, Square, Check, Zap } from 'lucide-react';
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

const ratioIcons: Record<Orientation, typeof Monitor> = {
  landscape: Monitor,
  portrait: Smartphone,
  square: Square,
};

// ── Helper sub-components ──

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-primary/20 bg-black/50 rounded-lg p-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="w-0.5 h-2.5 bg-primary/50 rounded-full" />
        <span className="text-[10px] font-mono font-bold uppercase tracking-[0.15em]">{title}</span>
      </div>
      {children}
    </div>
  );
}

function InlineSetting({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[9px] font-mono text-muted-foreground/60 shrink-0">{label}</span>
      {children}
    </div>
  );
}

function OnOffToggle({ enabled, onChange }: { enabled: boolean; onChange?: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange?.(!enabled)}
      className={cn(
        'px-3 py-1.5 rounded border text-[10px] font-mono font-bold tracking-wider',
        enabled
          ? 'bg-primary/20 border-primary/50 text-primary'
          : 'bg-black/40 border-white/10 text-muted-foreground',
      )}
    >
      {enabled ? 'ON' : 'OFF'}
    </button>
  );
}

function CompactSelect<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange?: (value: T) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange?.(e.target.value as T)}
      className="max-w-[140px] px-2 py-1.5 rounded border border-white/10 bg-black/40 text-[10px] font-mono font-bold text-foreground/80 cursor-pointer focus:border-primary/50 focus:outline-none"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
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
    <div className="grid grid-cols-2 gap-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange?.(opt.value)}
          className={cn(
            'px-2 py-1.5 rounded border text-[10px] font-mono font-bold text-center',
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
    <span className="px-2 py-1.5 rounded border border-white/10 bg-black/40 text-[10px] font-mono font-bold text-foreground/80">
      {value}{unit ? ` ${unit}` : ''}
    </span>
  );
}

function ColorSwatch({ value, onChange }: { value: string; onChange?: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-6 h-6 rounded border border-white/10 bg-transparent cursor-pointer [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
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
    <div className="p-2.5 flex flex-col gap-1.5 h-full">
      {/* Orientations — full-width row */}
      <SettingsSection title="Orientations">
        <div className="flex gap-1">
          {orientations.map((o) => {
            const Icon = ratioIcons[o.orient];
            return (
              <button
                key={o.orient}
                onClick={() => onOrientationClick?.(o.orient)}
                disabled={o.rendering}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border font-mono',
                  o.active
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-zinc-800/60 bg-black/40 text-muted-foreground',
                  o.rendering && 'opacity-50',
                )}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="font-bold text-[11px]">{orientationShortLabels[o.orient]}</span>
                {o.rendered && o.active && <Check className="w-3 h-3 text-primary" />}
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full shrink-0',
                    o.rendering ? 'bg-primary animate-pulse' : o.rendered ? 'bg-primary' : 'bg-muted-foreground/20',
                  )}
                />
              </button>
            );
          })}
        </div>
      </SettingsSection>

      {/* Settings in 2 columns */}
      <div className="grid grid-cols-2 gap-1.5 items-start">
        {/* Left column: Subtitles */}
        <SettingsSection title="Subtitles">
          <InlineSetting label="Enabled">
            <OnOffToggle
              enabled={subtitlesEnabled}
              onChange={(v) => onSubtitleChange?.('enabled', v)}
            />
          </InlineSetting>
          <InlineSetting label="Style">
            <CompactSelect
              options={[
                { label: 'TikDance', value: 'tikdance' as const },
                { label: 'Highlight', value: 'highlight' as const },
              ]}
              value={subtitleStyle}
              onChange={(v) => onSubtitleChange?.('style', v)}
            />
          </InlineSetting>
          <InlineSetting label="Position">
            <CompactSelect
              options={[
                { label: 'Top', value: 'top' as const },
                { label: 'Middle', value: 'middle' as const },
                { label: 'Bottom', value: 'bottom' as const },
              ]}
              value={subtitlePosition}
              onChange={(v) => onSubtitleChange?.('position', v)}
            />
          </InlineSetting>
          <InlineSetting label="Font Size">
            <CompactSelect
              options={[
                { label: 'Small', value: 'small' as const },
                { label: 'Medium', value: 'medium' as const },
                { label: 'Large', value: 'large' as const },
              ]}
              value={fontSize}
              onChange={(v) => onSubtitleChange?.('fontSize', v)}
            />
          </InlineSetting>
          <InlineSetting label="Text Color">
            <ColorSwatch value={textColor} onChange={(v) => onSubtitleChange?.('textColor', v)} />
          </InlineSetting>
          <InlineSetting label="Highlight Color">
            <ColorSwatch value={highlightColor} onChange={(v) => onSubtitleChange?.('highlightColor', v)} />
          </InlineSetting>
        </SettingsSection>

        {/* Right column: Audio + OSG + Background */}
        <div className="space-y-1.5">
          <SettingsSection title="Audio">
            <InlineSetting label="Volume">
              <NumberDisplay value={audioVolume} />
            </InlineSetting>
            <InlineSetting label="Fade In">
              <NumberDisplay value={audioFadeIn} unit="ms" />
            </InlineSetting>
            <InlineSetting label="Fade Out">
              <NumberDisplay value={audioFadeOut} unit="ms" />
            </InlineSetting>
          </SettingsSection>
          <SettingsSection title="OSG">
            <InlineSetting label="Enabled">
              <OnOffToggle
                enabled={osgEnabled}
                onChange={(v) => onOsgChange?.('enabled', v)}
              />
            </InlineSetting>
            <InlineSetting label="Position">
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
            </InlineSetting>
          </SettingsSection>
          <SettingsSection title="Background">
            <InlineSetting label="Mode">
              <CompactSelect
                options={[
                  { label: 'Blur', value: 'blur' as const },
                  { label: 'Black', value: 'black' as const },
                ]}
                value={backgroundMode}
                onChange={onBackgroundChange}
              />
            </InlineSetting>
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
