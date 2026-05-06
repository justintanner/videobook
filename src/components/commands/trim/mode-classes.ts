import type { TrimMode } from './types';

export interface ModeClasses {
  tint: string;
  line: string;
  text: string;
  border: string;
  soft: string;
  buttonVariant: 'plan' | 'fuchsia' | 'video' | 'final';
}

const KEEP: ModeClasses = {
  tint: 'bg-emerald-500/24',
  line: 'bg-emerald-400',
  text: 'text-emerald-300',
  border: 'border-emerald-400/60',
  soft: 'bg-emerald-500/10',
  buttonVariant: 'plan',
};

const REMOVE: ModeClasses = {
  tint: 'bg-red-500/24',
  line: 'bg-red-400',
  text: 'text-red-300',
  border: 'border-red-400/60',
  soft: 'bg-red-500/10',
  buttonVariant: 'fuchsia',
};

const SPLIT: ModeClasses = {
  tint: 'bg-violet-500/24',
  line: 'bg-violet-400',
  text: 'text-violet-300',
  border: 'border-violet-400/60',
  soft: 'bg-violet-500/10',
  buttonVariant: 'video',
};

const OVER_CAP: ModeClasses = {
  tint: 'bg-amber-500/24',
  line: 'bg-amber-400',
  text: 'text-amber-300',
  border: 'border-amber-400/60',
  soft: 'bg-amber-500/10',
  buttonVariant: 'final',
};

export function getModeClasses(mode: TrimMode, overCap = false): ModeClasses {
  if (overCap) return OVER_CAP;
  if (mode === 'keep') return KEEP;
  if (mode === 'remove') return REMOVE;
  return SPLIT;
}
