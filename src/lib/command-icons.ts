import type { LucideIcon } from 'lucide-react';
import {
  Zap,
  Sparkles,
  Scissors,
  Mic,
  Check,
  Clapperboard,
  Mailbox,
  ClipboardCopy,
  FolderOpen,
  History,
} from 'lucide-react';

const iconMap: Record<string, LucideIcon> = {
  Zap,
  Sparkles,
  Scissors,
  Mic,
  Check,
  Clapperboard,
  Mailbox,
  ClipboardCopy,
  FolderOpen,
  History,
};

export function resolveIcon(name: string): LucideIcon | undefined {
  return iconMap[name];
}
