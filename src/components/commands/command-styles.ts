import { chipVariant, type ChipVariantStyle, type Domain } from '@/theme/domains';

export const sizes = {
  sm: {
    button: 'h-5 border border-primary/25 text-[10px]',
    chevronPad: 'px-1',
    promptPad: 'px-1.5 gap-1',
    iconPad: 'px-1',
    text: 'text-[10px] tracking-wider',
    chevron: 'text-xs',
    cursor: 'h-2',
    iconSize: 'w-3 h-3',
    dot: 'w-1 h-1',
    scanWidth: 'w-6',
  },
  default: {
    button: 'h-8 border border-primary/25',
    chevronPad: 'px-2',
    promptPad: 'px-2.5 gap-1.5',
    iconPad: 'px-2',
    text: 'text-xs tracking-widest',
    chevron: 'text-sm',
    cursor: 'h-3',
    iconSize: 'w-5 h-5',
    dot: 'w-1.5 h-1.5',
    scanWidth: 'w-12',
  },
  lg: {
    button: 'h-12 border-2 border-cyan-400 bg-cyan-500/20 text-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.3)]',
    chevronPad: 'px-3',
    promptPad: 'px-4 gap-2',
    iconPad: 'px-3',
    text: 'text-sm tracking-[0.2em]',
    chevron: 'text-xl font-bold',
    cursor: 'h-4',
    iconSize: 'w-5 h-5',
    dot: 'w-1.5 h-1.5',
    scanWidth: 'w-12',
  },
} as const;

// Chip variants — keyed by Domain. The `fuchsia` semantic variant is kept
// for the split editor action button; it has no Domain mapping.

const fuchsia: ChipVariantStyle = {
  bg: 'bg-fuchsia-500/20 border-fuchsia-500/30',
  shadow: 'rgba(217,70,239,0.5)',
  chevron: 'text-fuchsia-400/40 group-hover:text-fuchsia-400/50',
  chevronDown: 'text-fuchsia-400/40 group-hover:text-fuchsia-400/60',
  cursorBg: 'bg-fuchsia-400/40',
  promptBg: 'bg-black/40 shadow-[inset_0_0_10px_rgba(217,70,239,0.05)]',
  promptHover: 'group-hover:bg-black/60 group-hover:shadow-[inset_0_0_10px_rgba(217,70,239,0.12)]',
  text: 'text-fuchsia-400/70 group-hover:text-fuchsia-400/90',
  icon: 'text-fuchsia-400/80 group-hover:text-fuchsia-400',
  hoverBorder: 'hover:border-fuchsia-400/40',
  focusRing: 'focus-visible:ring-fuchsia-400/80',
  focusWithinRing: 'focus-within:ring-fuchsia-400/80',
};

export const variants: Record<Domain | 'fuchsia', ChipVariantStyle> = {
  projects: chipVariant('projects'),
  image: chipVariant('image'),
  video: chipVariant('video'),
  notebook: chipVariant('notebook'),
  final: chipVariant('final'),
  fuchsia,
};
