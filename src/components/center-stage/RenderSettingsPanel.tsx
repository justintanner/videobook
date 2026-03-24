import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Zap, Type, Volume2, Tv, ImageIcon, Plus, Minus } from 'lucide-react';
import { CommandButton } from '@/components/commands';
import { AssetDropSlot } from '@/components/ui/AssetDropSlot';
import type { ExecuteButtonState } from '@/components/commands/types';
import type { Orientation } from '@/hooks/useTimeline';

// ── Types ──

export interface OrientationEntry {
  orient: Orientation;
  active: boolean;
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
  strokeWidth: number;
  strokeColor: string;
  shadowBlur: number;
  shadowOpacity: number;
  onSubtitleChange?: (field: string, value: string | boolean | number) => void;

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

// ── Color themes for sections ──

const sectionThemes = {
  cyan: {
    headerBg: 'bg-cyan-500/15',
    headerBorder: 'border-cyan-500/30',
    headerText: 'text-cyan-400',
    headerIcon: 'text-cyan-400/70',
    activeBg: 'bg-cyan-500/20',
    activeBorder: 'border-cyan-400',
    activeText: 'text-cyan-300',
    activeGlow: '0 0 12px rgba(34,211,238,0.25)',
    dimText: 'text-zinc-400',
  },
  violet: {
    headerBg: 'bg-violet-500/15',
    headerBorder: 'border-violet-500/30',
    headerText: 'text-violet-400',
    headerIcon: 'text-violet-400/70',
    activeBg: 'bg-violet-500/20',
    activeBorder: 'border-violet-400',
    activeText: 'text-violet-300',
    activeGlow: '0 0 12px rgba(139,92,246,0.25)',
    dimText: 'text-zinc-400',
  },
  amber: {
    headerBg: 'bg-amber-500/15',
    headerBorder: 'border-amber-500/30',
    headerText: 'text-amber-400',
    headerIcon: 'text-amber-400/70',
    activeBg: 'bg-amber-500/20',
    activeBorder: 'border-amber-400',
    activeText: 'text-amber-300',
    activeGlow: '0 0 12px rgba(245,158,11,0.25)',
    dimText: 'text-zinc-400',
  },
  emerald: {
    headerBg: 'bg-emerald-500/15',
    headerBorder: 'border-emerald-500/30',
    headerText: 'text-emerald-400',
    headerIcon: 'text-emerald-400/70',
    activeBg: 'bg-emerald-500/20',
    activeBorder: 'border-emerald-400',
    activeText: 'text-emerald-300',
    activeGlow: '0 0 12px rgba(16,185,129,0.25)',
    dimText: 'text-zinc-400',
  },
} as const;

type SectionTheme = typeof sectionThemes[keyof typeof sectionThemes];

const orientationCommands: Record<Orientation, string> = {
  landscape: '/landscape',
  portrait: '/portrait',
  square: '/square',
};

// ── Section header styled like a CommandButton pill ──

function SectionHeader({ tag, icon, theme }: { tag: string; icon: React.ReactNode; theme: SectionTheme }) {
  return (
    <div className={cn(
      'flex items-center gap-2 px-3 py-1.5 rounded border',
      theme.headerBg, theme.headerBorder,
    )}>
      <span className={cn('flex items-center justify-center', theme.headerIcon)}>
        <span className="font-mono text-sm opacity-60">›</span>
      </span>
      <span className={cn('font-mono font-bold text-xs tracking-widest', theme.headerText)}>
        {tag}
      </span>
      <span className={cn('ml-auto', theme.headerIcon)}>{icon}</span>
    </div>
  );
}

// ── Setting row ──

function SettingRow({ label, theme, children }: { label: string; theme: SectionTheme; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 min-h-[32px]">
      <span className={cn('text-xs font-mono tracking-wide shrink-0', theme.dimText)}>
        {label}
      </span>
      {children}
    </div>
  );
}

// ── Toggle pills (like mini command buttons) ──

function PillToggle<T extends string>({
  options, value, onChange, disabled, theme,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange?: (value: T) => void;
  disabled?: boolean;
  theme: SectionTheme;
}) {
  return (
    <div className={cn('flex gap-1.5', disabled && 'opacity-30 pointer-events-none')}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            disabled={disabled}
            onClick={() => onChange?.(opt.value)}
            className={cn(
              'h-8 min-w-[48px] px-3 rounded font-mono font-bold text-xs tracking-wider transition-all duration-150 border',
              active
                ? cn(theme.activeBg, theme.activeBorder, theme.activeText)
                : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600',
            )}
            style={active ? { boxShadow: theme.activeGlow } : undefined}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Segmented control ──

function SegmentedControl<T extends string>({
  options, value, onChange, disabled, theme,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange?: (value: T) => void;
  disabled?: boolean;
  theme: SectionTheme;
}) {
  return (
    <div className={cn(
      'flex rounded border border-zinc-700/50 overflow-hidden',
      disabled && 'opacity-30 pointer-events-none',
    )}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            disabled={disabled}
            onClick={() => onChange?.(opt.value)}
            className={cn(
              'flex-1 h-8 px-3 font-mono font-bold text-xs tracking-wider transition-all duration-150',
              active
                ? cn(theme.activeBg, theme.activeText)
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/30',
            )}
            style={active ? { boxShadow: theme.activeGlow } : undefined}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── 2x2 position grid (visual mini-map) ──

function PositionGrid<T extends string>({
  options, value, onChange, disabled, theme,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange?: (value: T) => void;
  disabled?: boolean;
  theme: SectionTheme;
}) {
  return (
    <div className={cn(
      'grid grid-cols-2 gap-1 rounded border p-1',
      disabled ? 'opacity-30 pointer-events-none' : '',
      'border-zinc-700/50 bg-zinc-900/40',
    )}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            disabled={disabled}
            onClick={() => onChange?.(opt.value)}
            className={cn(
              'h-9 rounded font-mono font-bold text-xs tracking-wider transition-all duration-150 border',
              active
                ? cn(theme.activeBg, theme.activeBorder, theme.activeText)
                : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600',
            )}
            style={active ? { boxShadow: theme.activeGlow } : undefined}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Number input with +/- ──

function NumberInput({ value, onChange, unit, min = 0, max = 999, step = 1, disabled, theme }: {
  value: number;
  onChange?: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  theme: SectionTheme;
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
    <div className={cn('flex items-center gap-0', disabled && 'opacity-30 pointer-events-none')}>
      <button
        disabled={disabled}
        onClick={() => onChange?.(clamp(value - step))}
        className="w-8 h-8 flex items-center justify-center rounded-l border border-zinc-700/50 bg-zinc-800/50 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
      >
        <Minus className="w-3 h-3" />
      </button>
      <div
        className="w-[64px] h-8 px-2 flex items-center justify-end gap-1 cursor-text border-t border-b border-zinc-700/50 bg-zinc-900/60"
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
            className={cn('w-full h-full bg-transparent text-right text-sm font-mono font-bold outline-none tabular-nums', theme.activeText)}
          />
        ) : (
          <>
            <span className="text-sm font-mono font-bold tabular-nums text-white">
              {value}
            </span>
            {unit && <span className={cn('text-[10px] font-mono', theme.dimText)}>{unit}</span>}
          </>
        )}
      </div>
      <button
        disabled={disabled}
        onClick={() => onChange?.(clamp(value + step))}
        className="w-8 h-8 flex items-center justify-center rounded-r border border-zinc-700/50 bg-zinc-800/50 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
}

// ── Color swatch ──

function ColorSwatch({ value, onChange, disabled }: { value: string; onChange?: (v: string) => void; disabled?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2', disabled && 'opacity-30 pointer-events-none')}>
      <div className="relative w-8 h-8 rounded border border-zinc-700/50 flex items-center justify-center bg-zinc-800/50 overflow-hidden">
        <input
          type="color"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.value)}
          className="w-6 h-6 border-0 bg-transparent cursor-pointer [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-sm"
        />
      </div>
      <span className="text-[11px] font-mono text-zinc-500 tracking-wider">{value}</span>
    </div>
  );
}

// ── Main component ──

export function RenderSettingsPanel({
  orientations, onOrientationClick,
  subtitlesEnabled, subtitleStyle, subtitlePosition, fontSize,
  textColor = '#F8FAFC', highlightColor = '#991B1B',
  strokeWidth, strokeColor, shadowBlur, shadowOpacity, onSubtitleChange,
  audioVolume, audioFadeIn, audioFadeOut, onAudioChange,
  osgAssetId, osgAssetSrc, osgPosition, onOsgChange,
  backgroundMode, onBackgroundChange,
  onApply, applyState, disabled,
}: RenderSettingsPanelProps) {
  const [armed, setArmed] = useState(false);
  const cyan = sectionThemes.cyan;
  const violet = sectionThemes.violet;
  const amber = sectionThemes.amber;
  const emerald = sectionThemes.emerald;

  return (
    <div className="flex flex-col h-full bg-zinc-950 relative overflow-hidden">
      {/* Scrollable content */}
      <div className="relative flex-1 overflow-auto px-4 pt-3 pb-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {/* Orientation tabs — styled as slash-command pills */}
        <div className="flex gap-2 mb-4">
          {orientations.map((o) => (
            <button
              key={o.orient}
              onClick={() => onOrientationClick?.(o.orient)}
              className={cn(
                'group flex items-center gap-0 h-8 rounded overflow-hidden font-mono font-bold text-xs tracking-widest transition-all duration-150 border',
                o.active
                  ? 'bg-cyan-500/10 border-primary/25'
                  : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600',
              )}
            >
              <span className={cn(
                'flex items-center justify-center px-2 h-full',
                o.active ? 'text-primary/40' : 'text-zinc-600',
              )}>
                ›
              </span>
              <span className={cn(
                'flex items-center h-full px-2.5 transition-all',
                o.active
                  ? 'bg-black/40 text-primary/70 shadow-[inset_0_0_10px_rgba(0,255,255,0.05)]'
                  : 'text-zinc-500',
              )}>
                {orientationCommands[o.orient]}
              </span>
            </button>
          ))}
        </div>

        {/* Settings in 2 columns */}
        <div className="grid grid-cols-2 gap-4 items-start">
          {/* Left column: /subs */}
          <div className="space-y-2.5">
            <SectionHeader tag="/subs" icon={<Type className="w-4 h-4" />} theme={cyan} />
            <div className="space-y-2 px-1">
              <SettingRow label="Enabled" theme={cyan}>
                <PillToggle theme={cyan} disabled={disabled} options={[{ label: 'ON', value: 'on' }, { label: 'OFF', value: 'off' }]} value={subtitlesEnabled ? 'on' : 'off'} onChange={(v) => onSubtitleChange?.('enabled', v === 'on')} />
              </SettingRow>
              <SegmentedControl theme={cyan} disabled={disabled} options={[{ label: 'IMPACT', value: 'impact' }, { label: 'HIGHLIGHT', value: 'highlight' }]} value={subtitleStyle} onChange={(v) => onSubtitleChange?.('style', v)} />
              <SettingRow label="Position" theme={cyan}>
                <PillToggle theme={cyan} disabled={disabled} options={[{ label: 'TOP', value: 'top' }, { label: 'MID', value: 'middle' }, { label: 'BTM', value: 'bottom' }]} value={subtitlePosition} onChange={(v) => onSubtitleChange?.('position', v)} />
              </SettingRow>
              <SettingRow label="Size" theme={cyan}>
                <PillToggle theme={cyan} disabled={disabled} options={[{ label: 'S', value: 'small' }, { label: 'M', value: 'medium' }, { label: 'L', value: 'large' }]} value={fontSize} onChange={(v) => onSubtitleChange?.('fontSize', v)} />
              </SettingRow>
              <SettingRow label="Text" theme={cyan}>
                <ColorSwatch disabled={disabled} value={textColor} onChange={(v) => onSubtitleChange?.('textColor', v)} />
              </SettingRow>
              <SettingRow label="Highlight" theme={cyan}>
                <ColorSwatch disabled={disabled} value={highlightColor} onChange={(v) => onSubtitleChange?.('highlightColor', v)} />
              </SettingRow>
              <SettingRow label="Stroke" theme={cyan}>
                <NumberInput theme={cyan} disabled={disabled} value={strokeWidth} onChange={(v) => onSubtitleChange?.('strokeWidth', v)} min={0} max={20} step={1} unit="px" />
              </SettingRow>
              <SettingRow label="Str Color" theme={cyan}>
                <ColorSwatch disabled={disabled} value={strokeColor} onChange={(v) => onSubtitleChange?.('strokeColor', v)} />
              </SettingRow>
              <SettingRow label="Shadow" theme={cyan}>
                <NumberInput theme={cyan} disabled={disabled} value={shadowBlur} onChange={(v) => onSubtitleChange?.('shadowBlur', v)} min={0} max={30} step={1} unit="px" />
              </SettingRow>
              <SettingRow label="Opacity" theme={cyan}>
                <NumberInput theme={cyan} disabled={disabled} value={shadowOpacity} onChange={(v) => onSubtitleChange?.('shadowOpacity', v)} min={0} max={100} step={5} unit="%" />
              </SettingRow>
            </div>
          </div>

          {/* Right column: /audio, /bg, /osg */}
          <div className="space-y-4">
            {/* /audio */}
            <div className="space-y-2.5">
              <SectionHeader tag="/audio" icon={<Volume2 className="w-4 h-4" />} theme={violet} />
              <div className="space-y-2 px-1">
                <SettingRow label="Volume" theme={violet}>
                  <NumberInput theme={violet} disabled={disabled} value={audioVolume} onChange={(v) => onAudioChange?.('audioVolume', v)} min={0} max={100} step={5} unit="%" />
                </SettingRow>
                <SettingRow label="Fade In" theme={violet}>
                  <NumberInput theme={violet} disabled={disabled} value={audioFadeIn} onChange={(v) => onAudioChange?.('audioFadeIn', v)} min={0} max={2000} step={50} unit="ms" />
                </SettingRow>
                <SettingRow label="Fade Out" theme={violet}>
                  <NumberInput theme={violet} disabled={disabled} value={audioFadeOut} onChange={(v) => onAudioChange?.('audioFadeOut', v)} min={0} max={2000} step={50} unit="ms" />
                </SettingRow>
              </div>
            </div>

            {/* /bg */}
            <div className="space-y-2.5">
              <SectionHeader tag="/bg" icon={<ImageIcon className="w-4 h-4" />} theme={amber} />
              <div className="px-1">
                <SegmentedControl theme={amber} disabled={disabled} options={[{ label: 'BLUR', value: 'blur' }, { label: 'BLACK', value: 'black' }]} value={backgroundMode} onChange={onBackgroundChange} />
              </div>
            </div>

            {/* /osg */}
            <div className="space-y-2.5">
              <SectionHeader tag="/osg" icon={<Tv className="w-4 h-4" />} theme={emerald} />
              <div className="space-y-2.5 px-1">
                <div className="flex gap-2.5 items-stretch">
                  <div className="flex-1">
                    <AssetDropSlot
                      value={osgAssetId ? { id: osgAssetId, slug: osgAssetId, src: osgAssetSrc ?? '', type: 'image' } : null}
                      onChange={(asset) => { onOsgChange?.('assetId', asset?.id ?? null); onOsgChange?.('assetSrc', asset?.src ?? null); }}
                      acceptTypes={['image']}
                      disabled={disabled}
                    />
                  </div>
                  <div className="flex-1">
                    <PositionGrid theme={emerald} disabled={disabled} options={[{ label: 'TL', value: 'top-left' }, { label: 'TR', value: 'top-right' }, { label: 'BL', value: 'bottom-left' }, { label: 'BR', value: 'bottom-right' }]} value={osgPosition} onChange={(v) => onOsgChange?.('position', v)} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div className="shrink-0 flex items-center justify-end px-4 py-2.5 border-t border-zinc-800/60">
        <CommandButton
          command={armed ? 'confirm /render' : '/render'}
          icon={<Zap className="w-5 h-5" />}
          size="lg"
          state={applyState}
          onClick={() => { if (armed) { setArmed(false); onApply?.(); } else { setArmed(true); } }}
        />
      </div>
    </div>
  );
}
