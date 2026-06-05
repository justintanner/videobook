// ─────────────────────────────────────────────────────────────────────────────
// Canonical 5-domain palette
//
// One source of truth for every "what color is X surface" question. Five
// domains, each with one hue:
//
//   projects → zinc    (workspace navigation, not a content type)
//   image    → cyan
//   video    → violet
//   plan     → emerald
//   final    → amber
//
// Class strings are written out per-domain rather than computed from a hue
// name, because Tailwind v4's JIT needs to see every class as a literal at
// scan time. The "factory" functions below are lookups, not concatenators.
// ─────────────────────────────────────────────────────────────────────────────

export type Domain = 'projects' | 'image' | 'video' | 'plan' | 'final';

// ── Raw values (hex / rgb / CSS var) ──

const domainHex: Record<Domain, string> = {
  projects: '#a1a1aa',
  image: '#22d3ee',
  video: '#a78bfa',
  plan: '#34d399',
  final: '#fbbf24',
};

const domainRgb: Record<Domain, string> = {
  projects: '161, 161, 170',
  image: '34, 211, 238',
  video: '167, 139, 250',
  plan: '52, 211, 153',
  final: '251, 191, 36',
};

// chipVariant — matches the per-variant shape used by command-styles.ts
// (CommandButton chips). 9 fields per variant.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChipVariantStyle {
  bg: string;
  shadow: string;
  chevron: string;
  chevronDown: string;
  cursorBg: string;
  promptBg: string;
  promptHover: string;
  text: string;
  icon: string;
  hoverBorder: string;
  focusRing: string;
  focusWithinRing: string;
}

const chipVariants: Record<Domain, ChipVariantStyle> = {
  projects: {
    bg: 'bg-zinc-500/20 border-zinc-500/30',
    shadow: 'rgba(161,161,170,0.5)',
    chevron: 'text-zinc-400/40 group-hover:text-zinc-400/50',
    chevronDown: 'text-zinc-400/40 group-hover:text-zinc-400/60',
    cursorBg: 'bg-zinc-400/40',
    promptBg: 'bg-black/40 shadow-[inset_0_0_10px_rgba(161,161,170,0.05)]',
    promptHover: 'group-hover:bg-black/60 group-hover:shadow-[inset_0_0_10px_rgba(161,161,170,0.12)]',
    text: 'text-zinc-400/70 group-hover:text-zinc-400/90',
    icon: 'text-zinc-400/80 group-hover:text-zinc-400',
    hoverBorder: 'hover:border-zinc-400/40',
    focusRing: 'focus-visible:ring-zinc-400/80',
    focusWithinRing: 'focus-within:ring-zinc-400/80',
  },
  // image preserves today's "default" variant exactly: it uses text-primary
  // (the --color-primary CSS var) rather than text-cyan-400 because that is
  // the canonical brand color used in the rest of the app's chrome. Phase 3
  // can normalize this if desired.
  image: {
    bg: 'bg-cyan-500/10',
    shadow: 'rgba(34,211,238,0.5)',
    chevron: 'text-primary/40 group-hover:text-primary/50',
    chevronDown: 'text-primary/40 group-hover:text-primary/60',
    cursorBg: 'bg-primary/40',
    promptBg: 'bg-black/40 shadow-[inset_0_0_10px_rgba(0,255,255,0.05)]',
    promptHover: 'group-hover:bg-black/60 group-hover:shadow-[inset_0_0_10px_rgba(0,255,255,0.12)]',
    text: 'text-primary/70 group-hover:text-primary/90',
    icon: 'text-primary/80 group-hover:text-primary',
    hoverBorder: 'hover:border-cyan-400/40',
    focusRing: 'focus-visible:ring-cyan-400/80',
    focusWithinRing: 'focus-within:ring-cyan-400/80',
  },
  video: {
    bg: 'bg-violet-500/20 border-violet-500/30',
    shadow: 'rgba(139,92,246,0.5)',
    chevron: 'text-violet-400/40 group-hover:text-violet-400/50',
    chevronDown: 'text-violet-400/40 group-hover:text-violet-400/60',
    cursorBg: 'bg-violet-400/40',
    promptBg: 'bg-black/40 shadow-[inset_0_0_10px_rgba(139,92,246,0.05)]',
    promptHover: 'group-hover:bg-black/60 group-hover:shadow-[inset_0_0_10px_rgba(139,92,246,0.12)]',
    text: 'text-violet-400/70 group-hover:text-violet-400/90',
    icon: 'text-violet-400/80 group-hover:text-violet-400',
    hoverBorder: 'hover:border-violet-400/40',
    focusRing: 'focus-visible:ring-violet-400/80',
    focusWithinRing: 'focus-within:ring-violet-400/80',
  },
  plan: {
    bg: 'bg-emerald-500/20 border-emerald-500/30',
    shadow: 'rgba(16,185,129,0.5)',
    chevron: 'text-emerald-400/40 group-hover:text-emerald-400/50',
    chevronDown: 'text-emerald-400/40 group-hover:text-emerald-400/60',
    cursorBg: 'bg-emerald-400/40',
    promptBg: 'bg-black/40 shadow-[inset_0_0_10px_rgba(16,185,129,0.05)]',
    promptHover: 'group-hover:bg-black/60 group-hover:shadow-[inset_0_0_10px_rgba(16,185,129,0.12)]',
    text: 'text-emerald-400/70 group-hover:text-emerald-400/90',
    icon: 'text-emerald-400/80 group-hover:text-emerald-400',
    hoverBorder: 'hover:border-emerald-400/40',
    focusRing: 'focus-visible:ring-emerald-400/80',
    focusWithinRing: 'focus-within:ring-emerald-400/80',
  },
  final: {
    bg: 'bg-amber-500/20 border-amber-500/30',
    shadow: 'rgba(245,158,11,0.5)',
    chevron: 'text-amber-400/40 group-hover:text-amber-400/50',
    chevronDown: 'text-amber-400/40 group-hover:text-amber-400/60',
    cursorBg: 'bg-amber-400/40',
    promptBg: 'bg-black/40 shadow-[inset_0_0_10px_rgba(245,158,11,0.05)]',
    promptHover: 'group-hover:bg-black/60 group-hover:shadow-[inset_0_0_10px_rgba(245,158,11,0.12)]',
    text: 'text-amber-400/70 group-hover:text-amber-400/90',
    icon: 'text-amber-400/80 group-hover:text-amber-400',
    hoverBorder: 'hover:border-amber-400/40',
    focusRing: 'focus-visible:ring-amber-400/80',
    focusWithinRing: 'focus-within:ring-amber-400/80',
  },
};

export function chipVariant(d: Domain): ChipVariantStyle {
  return chipVariants[d];
}

// ─────────────────────────────────────────────────────────────────────────────
// sectionTheme — superset matching both gen-themes.ts GenTheme and
// RenderSettingsPanel.sectionThemes. Returns all fields either consumer might
// want; consumers pick what they need.
// ─────────────────────────────────────────────────────────────────────────────

export interface SectionTheme {
  // RenderSettingsPanel section chrome
  headerBg: string;
  headerBorder: string;
  headerText: string;
  headerIcon: string;
  sectionBorder: string;
  sectionBg: string;
  hexText: string;
  // Shared form controls
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
  // gen-themes specific
  focusBorder: string;
  // Slider arbitrary classes — written as literals per-domain so the
  // Tailwind v4 JIT can pick them up at scan time.
  sliderTrack: string;
  sliderThumb: string;
  placeholderText: string;
}

const sectionThemes: Record<Domain, SectionTheme> = {
  projects: {
    headerBg: 'bg-zinc-500/15',
    headerBorder: 'border-zinc-500/30',
    headerText: 'text-zinc-400',
    headerIcon: 'text-zinc-400/70',
    sectionBorder: 'border-zinc-500/15',
    sectionBg: 'bg-zinc-500/[0.03]',
    hexText: 'text-zinc-400/40',
    labelText: 'text-zinc-400/50',
    activeBg: 'bg-zinc-500/20',
    activeBorder: 'border-zinc-400',
    activeText: 'text-zinc-300',
    activeGlow: '0 0 12px rgba(161,161,170,0.25)',
    inactiveBorder: 'border-zinc-500/15',
    inactiveText: 'text-zinc-400/25',
    inactiveHoverText: 'hover:text-zinc-300/50',
    inactiveHoverBorder: 'hover:border-zinc-500/30',
    controlBorder: 'border-zinc-500/15',
    controlBg: 'bg-zinc-500/[0.04]',
    controlText: 'text-zinc-400/40',
    controlHover: 'hover:text-zinc-300/60 hover:bg-zinc-500/10',
    valueText: 'text-zinc-200',
    unitText: 'text-zinc-400/30',
    focusBorder: 'focus:border-zinc-400/40',
    sliderTrack: '[&::-webkit-slider-runnable-track]:bg-zinc-500/20 [&::-moz-range-track]:bg-zinc-500/20',
    sliderThumb: '[&::-webkit-slider-thumb]:bg-zinc-400 [&::-moz-range-thumb]:bg-zinc-400',
    placeholderText: 'placeholder:text-zinc-400/30',
  },
  image: {
    headerBg: 'bg-cyan-500/15',
    headerBorder: 'border-cyan-500/30',
    headerText: 'text-cyan-400',
    headerIcon: 'text-cyan-400/70',
    sectionBorder: 'border-cyan-500/15',
    sectionBg: 'bg-cyan-500/[0.03]',
    hexText: 'text-cyan-400/40',
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
    sliderTrack: '[&::-webkit-slider-runnable-track]:bg-cyan-500/20 [&::-moz-range-track]:bg-cyan-500/20',
    sliderThumb: '[&::-webkit-slider-thumb]:bg-cyan-400 [&::-moz-range-thumb]:bg-cyan-400',
    placeholderText: 'placeholder:text-cyan-400/30',
  },
  video: {
    headerBg: 'bg-violet-500/15',
    headerBorder: 'border-violet-500/30',
    headerText: 'text-violet-400',
    headerIcon: 'text-violet-400/70',
    sectionBorder: 'border-violet-500/15',
    sectionBg: 'bg-violet-500/[0.03]',
    hexText: 'text-violet-400/40',
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
    sliderTrack: '[&::-webkit-slider-runnable-track]:bg-violet-500/20 [&::-moz-range-track]:bg-violet-500/20',
    sliderThumb: '[&::-webkit-slider-thumb]:bg-violet-400 [&::-moz-range-thumb]:bg-violet-400',
    placeholderText: 'placeholder:text-violet-400/30',
  },
  plan: {
    headerBg: 'bg-emerald-500/15',
    headerBorder: 'border-emerald-500/30',
    headerText: 'text-emerald-400',
    headerIcon: 'text-emerald-400/70',
    sectionBorder: 'border-emerald-500/15',
    sectionBg: 'bg-emerald-500/[0.03]',
    hexText: 'text-emerald-400/40',
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
    sliderTrack: '[&::-webkit-slider-runnable-track]:bg-emerald-500/20 [&::-moz-range-track]:bg-emerald-500/20',
    sliderThumb: '[&::-webkit-slider-thumb]:bg-emerald-400 [&::-moz-range-thumb]:bg-emerald-400',
    placeholderText: 'placeholder:text-emerald-400/30',
  },
  final: {
    headerBg: 'bg-amber-500/15',
    headerBorder: 'border-amber-500/30',
    headerText: 'text-amber-400',
    headerIcon: 'text-amber-400/70',
    sectionBorder: 'border-amber-500/15',
    sectionBg: 'bg-amber-500/[0.03]',
    hexText: 'text-amber-400/40',
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
    sliderTrack: '[&::-webkit-slider-runnable-track]:bg-amber-500/20 [&::-moz-range-track]:bg-amber-500/20',
    sliderThumb: '[&::-webkit-slider-thumb]:bg-amber-400 [&::-moz-range-thumb]:bg-amber-400',
    placeholderText: 'placeholder:text-amber-400/30',
  },
};

export function sectionTheme(d: Domain): SectionTheme {
  return sectionThemes[d];
}

// ─────────────────────────────────────────────────────────────────────────────
// cardTone — matches the per-tone shape used by stateColors.ts TONE_STYLES.
// Returns rgba() composites for use in inline styles / CSS vars.
// ─────────────────────────────────────────────────────────────────────────────

export interface CardToneStyle {
  color: string;
  rgb: string;
  border: string;
  glow: string;
  soft: string;
  faint: string;
  dot: string | null;
}

export function cardTone(d: Domain): CardToneStyle {
  const rgb = domainRgb[d];
  return {
    color: domainHex[d],
    rgb,
    border: `rgba(${rgb}, 0.35)`,
    glow: `rgba(${rgb}, 0.35)`,
    soft: `rgba(${rgb}, 0.14)`,
    faint: `rgba(${rgb}, 0.06)`,
    dot: null,
  };
}
