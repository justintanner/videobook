import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Zap, Type, Volume2, Tv, ImageIcon, Plus, Minus, X } from 'lucide-react';
import { CommandButton } from '@/components/commands';
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
    sectionBorder: 'border-cyan-500/15',
    sectionBg: 'bg-cyan-500/[0.03]',
    labelText: 'text-cyan-400/50',
    activeBg: 'bg-cyan-500/20',
    activeBorder: 'border-cyan-400',
    activeText: 'text-cyan-300',
    activeGlow: '0 0 12px rgba(34,211,238,0.25)',
    inactiveBorder: 'border-cyan-500/15',
    inactiveText: 'text-cyan-400/25',
    inactiveHoverText: 'hover:text-cyan-300/50',
    inactiveHoverBorder: 'hover:border-cyan-500/30',
    controlBorder: 'border-cyan-500/15',
    controlBg: 'bg-cyan-500/[0.04]',
    controlText: 'text-cyan-400/40',
    controlHover: 'hover:text-cyan-300/60 hover:bg-cyan-500/10',
    valueText: 'text-cyan-200',
    unitText: 'text-cyan-400/30',
    hexText: 'text-cyan-400/40',
  },
  violet: {
    headerBg: 'bg-violet-500/15',
    headerBorder: 'border-violet-500/30',
    headerText: 'text-violet-400',
    headerIcon: 'text-violet-400/70',
    sectionBorder: 'border-violet-500/15',
    sectionBg: 'bg-violet-500/[0.03]',
    labelText: 'text-violet-400/50',
    activeBg: 'bg-violet-500/20',
    activeBorder: 'border-violet-400',
    activeText: 'text-violet-300',
    activeGlow: '0 0 12px rgba(139,92,246,0.25)',
    inactiveBorder: 'border-violet-500/15',
    inactiveText: 'text-violet-400/25',
    inactiveHoverText: 'hover:text-violet-300/50',
    inactiveHoverBorder: 'hover:border-violet-500/30',
    controlBorder: 'border-violet-500/15',
    controlBg: 'bg-violet-500/[0.04]',
    controlText: 'text-violet-400/40',
    controlHover: 'hover:text-violet-300/60 hover:bg-violet-500/10',
    valueText: 'text-violet-200',
    unitText: 'text-violet-400/30',
    hexText: 'text-violet-400/40',
  },
  amber: {
    headerBg: 'bg-amber-500/15',
    headerBorder: 'border-amber-500/30',
    headerText: 'text-amber-400',
    headerIcon: 'text-amber-400/70',
    sectionBorder: 'border-amber-500/15',
    sectionBg: 'bg-amber-500/[0.03]',
    labelText: 'text-amber-400/50',
    activeBg: 'bg-amber-500/20',
    activeBorder: 'border-amber-400',
    activeText: 'text-amber-300',
    activeGlow: '0 0 12px rgba(245,158,11,0.25)',
    inactiveBorder: 'border-amber-500/15',
    inactiveText: 'text-amber-400/25',
    inactiveHoverText: 'hover:text-amber-300/50',
    inactiveHoverBorder: 'hover:border-amber-500/30',
    controlBorder: 'border-amber-500/15',
    controlBg: 'bg-amber-500/[0.04]',
    controlText: 'text-amber-400/40',
    controlHover: 'hover:text-amber-300/60 hover:bg-amber-500/10',
    valueText: 'text-amber-200',
    unitText: 'text-amber-400/30',
    hexText: 'text-amber-400/40',
  },
  emerald: {
    headerBg: 'bg-emerald-500/15',
    headerBorder: 'border-emerald-500/30',
    headerText: 'text-emerald-400',
    headerIcon: 'text-emerald-400/70',
    sectionBorder: 'border-emerald-500/15',
    sectionBg: 'bg-emerald-500/[0.03]',
    labelText: 'text-emerald-400/50',
    activeBg: 'bg-emerald-500/20',
    activeBorder: 'border-emerald-400',
    activeText: 'text-emerald-300',
    activeGlow: '0 0 12px rgba(16,185,129,0.25)',
    inactiveBorder: 'border-emerald-500/15',
    inactiveText: 'text-emerald-400/25',
    inactiveHoverText: 'hover:text-emerald-300/50',
    inactiveHoverBorder: 'hover:border-emerald-500/30',
    controlBorder: 'border-emerald-500/15',
    controlBg: 'bg-emerald-500/[0.04]',
    controlText: 'text-emerald-400/40',
    controlHover: 'hover:text-emerald-300/60 hover:bg-emerald-500/10',
    valueText: 'text-emerald-200',
    unitText: 'text-emerald-400/30',
    hexText: 'text-emerald-400/40',
  },
} as const;

type SectionTheme = typeof sectionThemes[keyof typeof sectionThemes];

const orientationCommands: Record<Orientation, string> = {
  landscape: '/landscape',
  portrait: '/portrait',
  square: '/square',
};

// ── Section container with colored border + bg tint ──

function Section({ tag, icon, theme, children }: { tag: string; icon: React.ReactNode; theme: SectionTheme; children: React.ReactNode }) {
  return (
    <div className={cn('rounded border', theme.sectionBorder, theme.sectionBg)}>
      {/* Header */}
      <div className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-t border-b',
        theme.headerBg, theme.headerBorder,
      )}>
        <span className={cn('font-mono font-bold text-xs tracking-widest', theme.headerText)}>
          {tag}
        </span>
        <span className={cn('ml-auto', theme.headerIcon)}>{icon}</span>
      </div>
      {/* Body */}
      <div className="px-3 py-2.5 space-y-2">
        {children}
      </div>
    </div>
  );
}

// ── Setting row ──

function SettingRow({ label, theme, children }: { label: string; theme: SectionTheme; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 min-h-[32px]">
      <span className={cn('text-xs font-mono tracking-wide shrink-0', theme.labelText)}>
        {label}
      </span>
      {children}
    </div>
  );
}

// ── Toggle pills ──

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
                : cn(theme.controlBg, theme.inactiveBorder, theme.inactiveText, theme.inactiveHoverText, theme.inactiveHoverBorder),
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
      'flex rounded border overflow-hidden',
      theme.controlBorder,
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
                : cn(theme.inactiveText, theme.inactiveHoverText, 'hover:bg-black/20'),
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

// ── 2x2 position grid ──

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
      theme.controlBorder, theme.controlBg,
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
                : cn(theme.controlBg, theme.inactiveBorder, theme.inactiveText, theme.inactiveHoverText, theme.inactiveHoverBorder),
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
        className={cn(
          'w-8 h-8 flex items-center justify-center rounded-l border transition-colors',
          theme.controlBorder, theme.controlBg, theme.controlText, theme.controlHover,
        )}
      >
        <Minus className="w-3 h-3" />
      </button>
      <div
        className={cn(
          'w-[64px] h-8 px-2 flex items-center justify-end gap-1 cursor-text border-t border-b',
          theme.controlBorder, theme.controlBg,
        )}
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
            <span className={cn('text-sm font-mono font-bold tabular-nums', theme.valueText)}>
              {value}
            </span>
            {unit && <span className={cn('text-[10px] font-mono', theme.unitText)}>{unit}</span>}
          </>
        )}
      </div>
      <button
        disabled={disabled}
        onClick={() => onChange?.(clamp(value + step))}
        className={cn(
          'w-8 h-8 flex items-center justify-center rounded-r border transition-colors',
          theme.controlBorder, theme.controlBg, theme.controlText, theme.controlHover,
        )}
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
}

// ── Themed asset drop slot ──

function ThemedDropSlot({ value, onChange, disabled, theme }: {
  value: { id: string; slug: string; src: string } | null;
  onChange: (asset: { id: string; slug: string; src: string; type: 'image' } | null) => void;
  disabled?: boolean;
  theme: SectionTheme;
}) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (disabled) return;
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled) return;
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'));
      if (data && data.type === 'image') {
        onChange({ id: data.id, slug: data.slug, src: data.filePath || data.src, type: 'image' });
      }
    } catch { /* invalid drop */ }
  };

  return (
    <div
      className={cn(
        'relative w-full h-full rounded border transition-all duration-200 overflow-hidden',
        disabled && 'opacity-30 pointer-events-none',
        isDragOver && !disabled
          ? cn(theme.activeBorder, 'border-solid')
          : value
            ? cn(theme.controlBorder, 'border-solid')
            : cn(theme.controlBorder, 'border-dashed', theme.inactiveHoverBorder),
        theme.controlBg,
      )}
      style={isDragOver ? { boxShadow: theme.activeGlow } : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {value ? (
        <>
          {value.src ? (
            <img src={value.src} alt={value.slug} draggable={false} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className={cn('text-xs font-mono truncate px-2', theme.labelText)}>{value.slug}</span>
            </div>
          )}
          {!disabled && (
            <button
              onClick={(e) => { e.stopPropagation(); onChange(null); }}
              className={cn(
                'absolute top-1 right-1 w-5 h-5 rounded flex items-center justify-center transition-colors',
                theme.controlBg, theme.controlBorder, 'border',
                'hover:bg-red-500/30 hover:border-red-500/60',
              )}
            >
              <X className={cn('w-3 h-3', theme.controlText)} />
            </button>
          )}
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <ImageIcon className={cn(
            'w-5 h-5 transition-all duration-200',
            isDragOver ? cn(theme.activeText, 'scale-110') : theme.inactiveText,
          )} />
          <span className={cn('text-[10px] font-mono tracking-wider', theme.inactiveText)}>
            DROP
          </span>
        </div>
      )}
    </div>
  );
}

// ── Color swatch ──

function ColorSwatch({ value, onChange, disabled, theme }: { value: string; onChange?: (v: string) => void; disabled?: boolean; theme: SectionTheme }) {
  return (
    <div className={cn('flex items-center gap-2', disabled && 'opacity-30 pointer-events-none')}>
      <div className={cn(
        'relative w-8 h-8 rounded border flex items-center justify-center overflow-hidden',
        theme.controlBorder, theme.controlBg,
      )}>
        <input
          type="color"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.value)}
          className="w-6 h-6 border-0 bg-transparent cursor-pointer [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-sm"
        />
      </div>
      <span className={cn('text-[11px] font-mono tracking-wider', theme.hexText)}>{value}</span>
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
      <div className="relative flex-1 overflow-auto px-4 pt-0 pb-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {/* Orientation tabs — connected to content below */}
        <div className="flex border-b border-zinc-800/60">
          {orientations.map((o) => (
            <button
              key={o.orient}
              onClick={() => onOrientationClick?.(o.orient)}
              className={cn(
                'flex items-center gap-1.5 h-10 px-4 font-mono font-bold text-xs tracking-widest transition-all duration-150 border-b-2 -mb-px',
                o.active
                  ? 'border-primary text-primary/80'
                  : 'border-transparent text-zinc-600 hover:text-zinc-400 hover:border-zinc-700',
              )}
            >
              {orientationCommands[o.orient]}
            </button>
          ))}
        </div>

        {/* Settings in 2 columns */}
        <div className="grid grid-cols-2 gap-3 items-start mt-3">
          {/* Left column: /subs */}
          <Section tag="/subs" icon={<Type className="w-4 h-4" />} theme={cyan}>
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
              <ColorSwatch theme={cyan} disabled={disabled} value={textColor} onChange={(v) => onSubtitleChange?.('textColor', v)} />
            </SettingRow>
            <SettingRow label="Highlight" theme={cyan}>
              <ColorSwatch theme={cyan} disabled={disabled} value={highlightColor} onChange={(v) => onSubtitleChange?.('highlightColor', v)} />
            </SettingRow>
            <SettingRow label="Stroke" theme={cyan}>
              <NumberInput theme={cyan} disabled={disabled} value={strokeWidth} onChange={(v) => onSubtitleChange?.('strokeWidth', v)} min={0} max={20} step={1} unit="px" />
            </SettingRow>
            <SettingRow label="Str Color" theme={cyan}>
              <ColorSwatch theme={cyan} disabled={disabled} value={strokeColor} onChange={(v) => onSubtitleChange?.('strokeColor', v)} />
            </SettingRow>
            <SettingRow label="Shadow" theme={cyan}>
              <NumberInput theme={cyan} disabled={disabled} value={shadowBlur} onChange={(v) => onSubtitleChange?.('shadowBlur', v)} min={0} max={30} step={1} unit="px" />
            </SettingRow>
            <SettingRow label="Opacity" theme={cyan}>
              <NumberInput theme={cyan} disabled={disabled} value={shadowOpacity} onChange={(v) => onSubtitleChange?.('shadowOpacity', v)} min={0} max={100} step={5} unit="%" />
            </SettingRow>
          </Section>

          {/* Right column: /audio, /bg, /osg */}
          <div className="space-y-3">
            {/* /audio */}
            <Section tag="/audio" icon={<Volume2 className="w-4 h-4" />} theme={violet}>
              <SettingRow label="Volume" theme={violet}>
                <NumberInput theme={violet} disabled={disabled} value={audioVolume} onChange={(v) => onAudioChange?.('audioVolume', v)} min={0} max={100} step={5} unit="%" />
              </SettingRow>
              <SettingRow label="Fade In" theme={violet}>
                <NumberInput theme={violet} disabled={disabled} value={audioFadeIn} onChange={(v) => onAudioChange?.('audioFadeIn', v)} min={0} max={2000} step={50} unit="ms" />
              </SettingRow>
              <SettingRow label="Fade Out" theme={violet}>
                <NumberInput theme={violet} disabled={disabled} value={audioFadeOut} onChange={(v) => onAudioChange?.('audioFadeOut', v)} min={0} max={2000} step={50} unit="ms" />
              </SettingRow>
            </Section>

            {/* /bg */}
            <Section tag="/bg" icon={<ImageIcon className="w-4 h-4" />} theme={amber}>
              <SegmentedControl theme={amber} disabled={disabled} options={[{ label: 'BLUR', value: 'blur' }, { label: 'BLACK', value: 'black' }]} value={backgroundMode} onChange={onBackgroundChange} />
            </Section>

            {/* /osg */}
            <Section tag="/osg" icon={<Tv className="w-4 h-4" />} theme={emerald}>
              <div className="grid grid-cols-2 gap-2" style={{ height: 88 }}>
                <ThemedDropSlot
                  theme={emerald}
                  disabled={disabled}
                  value={osgAssetId ? { id: osgAssetId, slug: osgAssetId, src: osgAssetSrc ?? '' } : null}
                  onChange={(asset) => { onOsgChange?.('assetId', asset?.id ?? null); onOsgChange?.('assetSrc', asset?.src ?? null); }}
                />
                <PositionGrid theme={emerald} disabled={disabled} options={[{ label: 'TL', value: 'top-left' }, { label: 'TR', value: 'top-right' }, { label: 'BL', value: 'bottom-left' }, { label: 'BR', value: 'bottom-right' }]} value={osgPosition} onChange={(v) => onOsgChange?.('position', v)} />
              </div>
            </Section>
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
