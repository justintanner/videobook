// Shared color themes for gen form controls, matching RenderSettingsPanel's sectionThemes.

export interface GenTheme {
  labelText: string;
  activeBg: string;
  activeBorder: string;
  activeText: string;
  activeGlow: string;
  inactiveBorder: string;
  inactiveText: string;
  inactiveHoverText: string;
  inactiveHoverBorder: string;
  controlBorder: string;
  controlBg: string;
  controlText: string;
  controlHover: string;
  valueText: string;
  unitText: string;
  focusBorder: string;
}

export const genThemes = {
  cyan: {
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
    focusBorder: 'focus:border-cyan-400/40',
  },
  violet: {
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
    focusBorder: 'focus:border-violet-400/40',
  },
  amber: {
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
    focusBorder: 'focus:border-amber-400/40',
  },
  emerald: {
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
    focusBorder: 'focus:border-emerald-400/40',
  },
} as const;
