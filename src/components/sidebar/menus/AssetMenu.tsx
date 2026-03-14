import type { ComponentType, ReactNode } from 'react';
import { ClipboardCopy, FolderOpen } from 'lucide-react';

interface AssetMenuProps {
  slug: string;
  onOpenFolder: () => void;
  MenuItem: ComponentType<{ onSelect: () => void; children: React.ReactNode; className?: string }>;
}

function CommandMenuItem({ icon, command, onSelect, MenuItem }: {
  icon: ReactNode;
  command: string;
  onSelect: () => void;
  MenuItem: ComponentType<{ onSelect: () => void; children: React.ReactNode; className?: string }>;
}) {
  return (
    <MenuItem onSelect={onSelect} className="py-2.5">
      <span className="font-mono text-muted-foreground/50 text-sm leading-none select-none mr-1">{'\u203A'}</span>
      <span className="font-mono font-bold text-xs tracking-wider leading-none flex-1">{command}</span>
      <span className="ml-2 opacity-80 flex items-center">{icon}</span>
    </MenuItem>
  );
}

export function AssetMenu({ slug, onOpenFolder, MenuItem }: AssetMenuProps) {
  return (
    <>
      <CommandMenuItem
        icon={<ClipboardCopy className="h-3 w-3" />}
        command="/copy_name"
        onSelect={() => navigator.clipboard.writeText(slug)}
        MenuItem={MenuItem}
      />
      <div className="-mx-1 my-1 h-px bg-border" />
      <CommandMenuItem
        icon={<FolderOpen className="h-3 w-3" />}
        command="/open_folder"
        onSelect={onOpenFolder}
        MenuItem={MenuItem}
      />
    </>
  );
}
