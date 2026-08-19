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
  Columns3,
  FolderOpen,
  History,
  Eye,
  Users,
  Archive,
  NotebookPen,
  Rows3,
  Stethoscope,
  Images,
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
  Columns3,
  FolderOpen,
  History,
  Eye,
  Users,
  Archive,
  NotebookPen,
  Rows3,
  Stethoscope,
  Images,
};

export function resolveIcon(name: string): LucideIcon | undefined {
  return iconMap[name];
}
