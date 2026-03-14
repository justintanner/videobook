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
};

export function resolveIcon(name: string): LucideIcon | undefined {
  return iconMap[name];
}
