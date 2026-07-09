import { cn } from '@/lib/utils';
import type { GenTheme } from '@/components/gen/ui/gen-themes';
import { genThemes } from '@/components/gen/ui/gen-themes';
import type { ModeSpec } from '@/components/gen/types';

interface ModeTabsProps {
  modes: ModeSpec[];
  activeKey: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  theme?: GenTheme;
  /** Per-mode-key flag: the mode owns non-empty values that aren't visible on
   *  the active tab. Renders a dot so hidden inputs stay discoverable. */
  valueHints?: Record<string, boolean>;
}

/** Mutually-exclusive input-mode selector for models that ship a modes
 *  contract. Styled like GenToggle; currently only the video gen panel uses it,
 *  so the value-hint dot is violet-tinted. */
export function ModeTabs({ modes, activeKey, onChange, disabled, theme, valueHints }: ModeTabsProps) {
  const t = theme ?? genThemes.video;
  return (
    <div className={cn('flex gap-1.5 flex-wrap', disabled && 'opacity-30 pointer-events-none')}>
      {modes.map((mode) => {
        const active = mode.key === activeKey;
        const hint = !active && !!valueHints?.[mode.key];
        return (
          <button
            key={mode.key}
            type="button"
            title={mode.description}
            onClick={() => !disabled && onChange(mode.key)}
            disabled={disabled}
            className={cn(
              'relative rounded font-mono font-bold tracking-wider border transition-all duration-150 h-8 px-3 text-xs',
              active
                ? cn(t.activeBg, t.activeBorder, t.activeText)
                : cn(t.controlBg, t.inactiveBorder, t.inactiveText, t.inactiveHoverText, t.inactiveHoverBorder),
              'focus-visible:ring-1 focus-visible:ring-primary/60 focus-visible:outline-none',
            )}
            style={active ? { boxShadow: t.activeGlow } : undefined}
          >
            {mode.label}
            {hint && (
              <span
                className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-violet-400"
                title="Has inputs"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
