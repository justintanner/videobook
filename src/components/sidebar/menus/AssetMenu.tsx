import type { ComponentType } from 'react';
import { ClipboardCopy, FolderOpen } from 'lucide-react';

interface AssetMenuProps {
  slug: string;
  onOpenFolder: () => void;
  MenuItem: ComponentType<{ onSelect: () => void; children: React.ReactNode }>;
}

export function AssetMenu({ slug, onOpenFolder, MenuItem }: AssetMenuProps) {
  return (
    <>
      <MenuItem onSelect={() => navigator.clipboard.writeText(slug)}>
        <ClipboardCopy className="mr-2 h-4 w-4" />
        Copy Name
      </MenuItem>
      <MenuItem onSelect={onOpenFolder}>
        <FolderOpen className="mr-2 h-4 w-4" />
        Open Folder
      </MenuItem>
    </>
  );
}
