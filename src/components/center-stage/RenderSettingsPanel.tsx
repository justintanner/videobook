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
    <div className="p-3 space-y-2.5" style={{ background: '#11151B', border: '1px solid #1F2A36' }}>
      <div className="flex items-center gap-2">
        {icon && <span className="text-primary/60">{icon}</span>}
        <span className="text-[12px] font-mono font-bold uppercase tracking-[0.12em] text-muted-foreground">{title}</span>
      </div>
      {children}
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="w-[96px] shrink-0 text-[13px] leading-[18px] font-mono text-muted-foreground">{label}</span>
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
            'h-8 min-w-[56px] px-3 text-[11px] font-mono font-bold transition-all duration-[120ms]',
            opt.value === value
              ? 'text-black'
              : 'text-white/50 hover:text-white/70',
          )}
          style={opt.value === value
            ? { background: '#00D9FF', boxShadow: '0 0 12px rgba(0,217,255,.3)' }
            : { background: '#1A1E26', border: '1px solid #2A3040' }
          }
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
    <div className="flex overflow-hidden" style={{ border: '1px solid #1F2A36' }}>
      {options.map((opt, i) => (
        <button
          key={opt.value}
          onClick={() => onChange?.(opt.value)}
          className={cn(
            'flex-1 h-8 px-2.5 text-[11px] font-mono font-bold transition-all duration-[120ms]',
            i > 0 && 'border-l',
            opt.value === value
              ? 'text-black'
              : 'text-muted-foreground hover:text-white/70',
          )}
          style={opt.value === value
            ? { background: '#00D9FF', borderColor: '#00D9FF', boxShadow: '0 0 10px rgba(0,217,255,.25)' }
            : { background: '#0D0F12', borderColor: '#1F2A36' }
          }
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
            'h-8 text-[11px] font-mono font-bold text-center transition-all duration-[120ms]',
            opt.value === value
              ? 'text-black'
              : 'text-muted-foreground hover:text-white/70',
          )}
          style={opt.value === value
            ? { background: '#00D9FF', boxShadow: '0 0 10px rgba(0,217,255,.25)' }
            : { background: '#0D0F12', border: '1px solid #1F2A36' }
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function NumberDisplay({ value, unit }: { value: number; unit?: string }) {
  return (
    <div className="w-[72px] h-8 px-2 flex items-center justify-end gap-1" style={{ background: '#0D0F12', border: '1px solid #1F2A36' }}>
      <span className="text-[14px] font-mono font-semibold" style={{ color: '#D8E7FF' }}>{value}</span>
      {unit && <span className="text-[9px] font-mono text-muted-foreground/50">{unit}</span>}
    </div>
  );
}

function ColorSwatch({ value, onChange }: { value: string; onChange?: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-5 h-5 border border-zinc-800/60 bg-transparent cursor-pointer [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-0"
      />
      <span className="text-[10px] font-mono" style={{ color: '#D8E7FF', opacity: 0.6 }}>{value}</span>
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
    <div className="p-4 flex flex-col gap-2 h-full" style={{ background: '#0D0F12' }}>
      {/* Scrollable content area */}
      <div className="flex-1 overflow-auto space-y-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {/* OUTPUT FORMAT — visual ratio cards (rec #6) */}
        <div className="space-y-1.5">
          <span className="text-[12px] font-mono font-bold uppercase tracking-[0.12em] text-muted-foreground">Output Format</span>
          <div className="flex gap-2">
            {orientations.map((o) => {
              const useCaseLabels: Record<Orientation, string> = { landscape: 'Landscape', portrait: 'Story', square: 'Square' };
              return (
                <button
                  key={o.orient}
                  onClick={() => onOrientationClick?.(o.orient)}
                  disabled={o.rendering}
                  className={cn(
                    'flex-1 h-14 flex flex-col items-center justify-center gap-0.5 font-mono transition-all duration-[160ms] relative overflow-hidden',
                    o.rendering && 'opacity-50',
                  )}
                  style={o.active
                    ? { background: 'rgba(0,217,255,0.06)', border: '1px solid rgba(0,217,255,0.4)', boxShadow: '0 0 16px rgba(0,217,255,.2)' }
                    : { background: '#0D0F12', border: '1px solid #1F2A36' }
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <span className={o.active ? 'text-cyan-400' : 'text-muted-foreground'}>{orientationIcons[o.orient]}</span>
                    <span className={cn('text-[12px] font-bold', o.active ? 'text-cyan-400' : 'text-muted-foreground')}>{orientationShortLabels[o.orient]}</span>
                    {o.rendered && <Check className="w-3 h-3 text-cyan-400" />}
                  </div>
                  <span className={cn('text-[9px] uppercase tracking-wider', o.active ? 'text-cyan-400/60' : 'text-muted-foreground/40')}>{useCaseLabels[o.orient]}</span>
                  {o.active && <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-cyan-400/60" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Settings in 2 columns */}
        <div className="grid grid-cols-2 gap-2 items-start">
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
            <div className="h-7 flex items-center justify-center" style={{ background: '#0D0F12', border: '1px solid #1F2A36' }}>
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
          <div className="space-y-2">
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
      <div className="shrink-0 flex items-center justify-end pt-2 border-t" style={{ borderColor: '#1F2A36' }}>
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
