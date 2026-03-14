import type { ComponentType, ReactNode } from 'react';
import { ClipboardCopy, FolderOpen, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';

interface AssetMenuProps {
  slug: string;
  onOpenFolder: () => void;
  onAnimateCommand?: (text: string) => void;
  MenuItem: ComponentType<{ onSelect: () => void; children: React.ReactNode; className?: string }>;
}

function CommandMenuItem({ icon, command, onSelect, MenuItem, className }: {
  icon: ReactNode;
  command: string;
  onSelect: () => void;
  MenuItem: ComponentType<{ onSelect: () => void; children: React.ReactNode; className?: string }>;
  className?: string;
}) {
  return (
    <MenuItem onSelect={onSelect} className={cn('py-2.5', className)}>
      <span className="font-mono text-muted-foreground/50 text-sm leading-none select-none mr-1">{'\u203A'}</span>
      <span className="font-mono font-bold text-xs tracking-wider leading-none flex-1">{command}</span>
      <span className="ml-2 opacity-80 flex items-center">{icon}</span>
    </MenuItem>
  );
}

export function AssetMenu({ slug, onOpenFolder, onAnimateCommand, MenuItem }: AssetMenuProps) {
  return (
    <>
      <CommandMenuItem
        icon={<ClipboardCopy className="h-3 w-3" />}
        command="/copy-name"
        onSelect={() => {
          navigator.clipboard.writeText(slug);
          toast({ title: 'Copied', description: slug, duration: 2000 });
        }}
        MenuItem={MenuItem}
      />
      <CommandMenuItem
        icon={<FolderOpen className="h-3 w-3" />}
        command="/open-folder"
        onSelect={onOpenFolder}
        MenuItem={MenuItem}
      />
      <div className="-mx-1 my-1 h-px bg-border" />
      <CommandMenuItem
        icon={<Trash2 className="h-3 w-3" />}
        command="/delete"
        onSelect={() => onAnimateCommand?.(`/delete ${slug}`)}
        MenuItem={MenuItem}
        className="text-red-400"
      />
    </>
  );
}
