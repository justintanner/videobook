import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Check, Zap, Type, Volume2, Tv, ImageIcon, Monitor, Smartphone, Square, Plus, Minus, Loader2 } from 'lucide-react';
import { CommandButton } from '@/components/commands';
import { AssetDropSlot } from '@/components/ui/AssetDropSlot';
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
  subtitleStyle: 'impact' | 'highlight';
  subtitlePosition: 'top' | 'middle' | 'bottom';
  fontSize: 'small' | 'medium' | 'large';
  textColor?: string;
  highlightColor?: string;
  onSubtitleChange?: (field: string, value: string | boolean) => void;

  audioVolume: number;
  audioFadeIn: number;
  audioFadeOut: number;
  onAudioChange?: (field: string, value: number) => void;

  osgAssetId: string | null;
  osgAssetSrc: string | null;
  osgPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  onOsgChange?: (field: string, value: string | boolean | null) => void;

  backgroundMode: 'blur' | 'black';
  onBackgroundChange?: (mode: 'blur' | 'black') => void;

  onApply?: () => void;
  applyState?: ExecuteButtonState;
  disabled?: boolean;
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
        <span className="text-[12px] font-mono font-bold tracking-[0.12em] text-muted-foreground">{title}</span>
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
  disabled,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange?: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn('flex gap-1', disabled && 'opacity-40 pointer-events-none')}>
      {options.map((opt) => (
        <button
          key={opt.value}
          disabled={disabled}
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
  disabled,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange?: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn('flex overflow-hidden', disabled && 'opacity-40 pointer-events-none')} style={{ border: '1px solid #1F2A36' }}>
      {options.map((opt, i) => (
        <button
          key={opt.value}
          disabled={disabled}
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
  disabled,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange?: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn('grid grid-cols-2 gap-1 w-full', disabled && 'opacity-40 pointer-events-none')}>
      {options.map((opt) => (
        <button
          key={opt.value}
          disabled={disabled}
          onClick={() => onChange?.(opt.value)}
          className={cn(
            'h-8 min-w-[56px] text-[11px] font-mono font-bold text-center transition-all duration-[120ms]',
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

function NumberInput({ value, onChange, unit, min = 0, max = 999, step = 1, disabled }: {
  value: number;
  onChange?: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  const clamp = (n: number) => Math.max(min, Math.min(max, n));

  const commitDraft = () => {
    const parsed = parseInt(draft, 10);
    if (!isNaN(parsed)) onChange?.(clamp(parsed));
    else setDraft(String(value));
    setEditing(false);
  };

  return (
    <div className={cn('flex items-center gap-0.5', disabled && 'opacity-40 pointer-events-none')}>
      <button
        disabled={disabled}
        onClick={() => onChange?.(clamp(value - step))}
        className="w-6 h-8 flex items-center justify-center text-muted-foreground/50 hover:text-white/70 transition-colors"
        style={{ background: '#1A1E26', border: '1px solid #2A3040' }}
      >
        <Minus className="w-3 h-3" />
      </button>
      <div
        className="w-[56px] h-8 px-1.5 flex items-center justify-end gap-0.5 cursor-text"
        style={{ background: '#0D0F12', border: '1px solid #1F2A36' }}
        onClick={() => { if (!disabled) { setDraft(String(value)); setEditing(true); } }}
      >
        {editing ? (
          <input
            autoFocus
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => { if (e.key === 'Enter') commitDraft(); if (e.key === 'Escape') setEditing(false); }}
            className="w-full h-full bg-transparent text-right text-[14px] font-mono font-semibold outline-none"
            style={{ color: '#D8E7FF' }}
          />
        ) : (
          <>
            <span className="text-[14px] font-mono font-semibold" style={{ color: '#D8E7FF' }}>{value}</span>
            {unit && <span className="text-[9px] font-mono text-muted-foreground/50">{unit}</span>}
          </>
        )}
      </div>
      <button
        disabled={disabled}
        onClick={() => onChange?.(clamp(value + step))}
        className="w-6 h-8 flex items-center justify-center text-muted-foreground/50 hover:text-white/70 transition-colors"
        style={{ background: '#1A1E26', border: '1px solid #2A3040' }}
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
}

function ColorSwatch({ value, onChange, disabled }: { value: string; onChange?: (v: string) => void; disabled?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2', disabled && 'opacity-40 pointer-events-none')}>
      <input
        type="color"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-8 h-8 border border-zinc-800/60 bg-transparent cursor-pointer [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-0"
      />
      <span className="text-xs font-mono" style={{ color: '#D8E7FF', opacity: 0.6 }}>{value}</span>
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
  onAudioChange,
  osgAssetId,
  osgAssetSrc,
  osgPosition,
  onOsgChange,
  backgroundMode,
  onBackgroundChange,
  onApply,
  applyState,
  disabled,
}: RenderSettingsPanelProps) {
  return (
    <div className="p-4 flex flex-col gap-2 h-full" style={{ background: '#0D0F12' }}>
      {/* Scrollable content area */}
      <div className="flex-1 overflow-auto space-y-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {/* OUTPUT FORMAT — tab bar */}
        <div className="flex gap-1">
          {orientations.map((o) => {
            const addLabels: Record<Orientation, string> = { landscape: '+ LANDSCAPE', portrait: '+ PORTRAIT', square: '+ SQUARE' };
            const isTab = o.rendered || o.active;

            if (o.rendering) {
              return (
                <button
                  key={o.orient}
                  disabled
                  className="h-8 px-3 flex items-center gap-1.5 font-mono text-[11px] font-bold text-muted-foreground/40 opacity-50 relative"
                  style={{ background: '#0D0F12' }}
                >
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>{orientationShortLabels[o.orient]}</span>
                </button>
              );
            }

            if (!isTab) {
              return (
                <button
                  key={o.orient}
                  disabled={disabled}
                  onClick={() => onOrientationClick?.(o.orient)}
                  className={cn(
                    'h-8 px-3 flex items-center gap-1 font-mono text-[11px] font-bold text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors duration-[120ms]',
                    disabled && 'opacity-40 pointer-events-none',
                  )}
                  style={{ background: 'transparent' }}
                >
                  <Plus className="w-3 h-3" />
                  <span>{addLabels[o.orient]}</span>
                </button>
              );
            }

            return (
              <button
                key={o.orient}
                disabled={disabled}
                onClick={() => onOrientationClick?.(o.orient)}
                className={cn(
                  'h-8 px-3 flex items-center gap-1.5 font-mono text-[11px] font-bold transition-all duration-[120ms] relative',
                  o.active ? 'text-cyan-400' : 'text-muted-foreground hover:text-white/70',
                  disabled && 'opacity-40 pointer-events-none',
                )}
                style={{ background: o.active ? 'rgba(0,217,255,0.06)' : 'transparent' }}
              >
                {orientationIcons[o.orient]}
                <span>{orientationShortLabels[o.orient]}</span>
                {o.rendered && !o.active && <Check className="w-3 h-3 text-cyan-400/60" />}
                {o.active && <div className="absolute bottom-0 left-1 right-1 h-[2px] bg-cyan-400" />}
              </button>
            );
          })}
        </div>

        {/* Settings in 2 columns: Subtitles+Background | Audio+OSG */}
        <div className="grid grid-cols-2 gap-2 items-start">
          {/* Left column: Subtitles + Background */}
          <div className="space-y-2">
            <SettingsSection title="/subs" icon={<Type className="w-3.5 h-3.5" />}>
              <SettingRow label="Enabled">
                <ToggleGroup
                  disabled={disabled}
                  options={[
                    { label: 'ON', value: 'on' },
                    { label: 'OFF', value: 'off' },
                  ]}
                  value={subtitlesEnabled ? 'on' : 'off'}
                  onChange={(v) => onSubtitleChange?.('enabled', v === 'on')}
                />
              </SettingRow>
              <SegmentedControl
                disabled={disabled}
                options={[
                  { label: 'Impact', value: 'impact' },
                  { label: 'Highlight', value: 'highlight' },
                ]}
                value={subtitleStyle}
                onChange={(v) => onSubtitleChange?.('style', v)}
              />
              <SettingRow label="Position">
                <ToggleGroup
                  disabled={disabled}
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
                  disabled={disabled}
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
                <ColorSwatch disabled={disabled} value={textColor} onChange={(v) => onSubtitleChange?.('textColor', v)} />
              </SettingRow>
              <SettingRow label="Highlight">
                <ColorSwatch disabled={disabled} value={highlightColor} onChange={(v) => onSubtitleChange?.('highlightColor', v)} />
              </SettingRow>
            </SettingsSection>

            <SettingsSection title="/bg" icon={<ImageIcon className="w-3.5 h-3.5" />}>
              <ToggleGroup
                disabled={disabled}
                options={[
                  { label: 'Blur', value: 'blur' },
                  { label: 'Black', value: 'black' },
                ]}
                value={backgroundMode}
                onChange={onBackgroundChange}
              />
            </SettingsSection>
          </div>

          {/* Right column: Audio + OSG */}
          <div className="space-y-2">
            <SettingsSection title="/audio" icon={<Volume2 className="w-3.5 h-3.5" />}>
              <SettingRow label="Volume">
                <NumberInput disabled={disabled} value={audioVolume} onChange={(v) => onAudioChange?.('audioVolume', v)} min={0} max={100} step={5} />
              </SettingRow>
              <SettingRow label="Fade In">
                <NumberInput disabled={disabled} value={audioFadeIn} onChange={(v) => onAudioChange?.('audioFadeIn', v)} min={0} max={2000} step={50} unit="ms" />
              </SettingRow>
              <SettingRow label="Fade Out">
                <NumberInput disabled={disabled} value={audioFadeOut} onChange={(v) => onAudioChange?.('audioFadeOut', v)} min={0} max={2000} step={50} unit="ms" />
              </SettingRow>
            </SettingsSection>

            <SettingsSection title="/osg" icon={<Tv className="w-3.5 h-3.5" />}>
              <AssetDropSlot
                value={osgAssetId ? { id: osgAssetId, slug: osgAssetId, src: osgAssetSrc ?? '', type: 'image' } : null}
                onChange={(asset) => {
                  onOsgChange?.('assetId', asset?.id ?? null);
                  onOsgChange?.('assetSrc', asset?.src ?? null);
                }}
                acceptTypes={['image']}
                disabled={disabled}
                compact
              />
              <SettingRow label="Position">
                <ToggleGrid
                  disabled={disabled}
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
