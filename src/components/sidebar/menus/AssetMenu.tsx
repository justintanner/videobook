import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';

interface AssetMenuProps {
  slug: string;
  itemType?: string;
  onShowFolder: () => void;
  onAnimateCommand?: (text: string) => void;
  onAnimateEdit?: (text: string) => void;
  MenuItem: ComponentType<{ onSelect: () => void; children: React.ReactNode; className?: string }>;
}

function CommandMenuItem({ command, title, titleClassName, accentColor, onSelect, MenuItem, className }: {
  command: string;
  title?: string;
  titleClassName?: string;
  accentColor?: string;
  onSelect: () => void;
  MenuItem: ComponentType<{ onSelect: () => void; children: React.ReactNode; className?: string }>;
  className?: string;
}) {
  return (
    <MenuItem onSelect={onSelect} className={cn(
      '!flex flex-col !items-stretch gap-1.5 py-3 px-3 border-l-[3px] bg-white/[0.02] focus:!bg-white/[0.12] focus:!text-inherit focus:!border-l-[3px]',
      accentColor ?? 'border-l-cyan-500/30 focus:border-l-cyan-500/60',
      className,
    )}>
      <span className={cn('text-sm font-semibold leading-none', titleClassName ?? 'text-foreground')}>{title ?? command}</span>
      {title && (
        <span className="font-mono text-muted-foreground text-xs tracking-wider leading-none">{command}</span>
      )}
    </MenuItem>
  );
}

export function AssetMenu({ slug, itemType, onShowFolder, onAnimateCommand, onAnimateEdit, MenuItem }: AssetMenuProps) {
  return (
    <>
      {itemType === 'image' && (
        <>
          <CommandMenuItem
            command={`/image ${slug}`}
            title="Generate Image"
            titleClassName="text-blue-400"
            accentColor="border-l-blue-500/50 focus:border-l-blue-500/80"
            onSelect={() => onAnimateCommand?.(`/image ${slug}`)}
            MenuItem={MenuItem}
          />
          <div className="-mx-1 my-1 h-px bg-border" />
          <CommandMenuItem
            command={`/video ${slug}`}
            title="Generate Video"
            titleClassName="text-fuchsia-400"
            accentColor="border-l-fuchsia-500/50 focus:border-l-fuchsia-500/80"
            onSelect={() => onAnimateCommand?.(`/video ${slug}`)}
            MenuItem={MenuItem}
          />
          <div className="-mx-1 my-1 h-px bg-border" />
        </>
      )}
      <CommandMenuItem
        command="/copy"
        title="Copy Slug"
        onSelect={() => {
          navigator.clipboard.writeText(slug);
          toast({ title: 'Copied', description: slug, duration: 2000 });
        }}
        MenuItem={MenuItem}
      />
      <div className="-mx-1 my-1 h-px bg-border" />
      <CommandMenuItem
        command="/folder"
        title="Show in Folder"
        onSelect={onShowFolder}
        MenuItem={MenuItem}
      />
      <div className="-mx-1 my-1 h-px bg-border" />
      <CommandMenuItem
        command={`/duplicate ${slug}`}
        title="Duplicate"
        onSelect={() => onAnimateCommand?.(`/duplicate ${slug}`)}
        MenuItem={MenuItem}
      />
      {itemType === 'video' && (
        <>
          <div className="-mx-1 my-1 h-px bg-border" />
          <CommandMenuItem
            command={`/trim ${slug}`}
            title="Trim Video"
            onSelect={() => onAnimateCommand?.(`/trim ${slug}`)}
            MenuItem={MenuItem}
          />
        </>
      )}
      <div className="-mx-1 my-1 h-px bg-border" />
      <CommandMenuItem
        command={`/rename ${slug}`}
        title="Rename"
        onSelect={() => onAnimateEdit?.(`/rename ${slug} `)}
        MenuItem={MenuItem}
      />
      <div className="-mx-1 my-1 h-px bg-border" />
      <CommandMenuItem
        command={`/delete ${slug}`}
        title="Delete"
        titleClassName="text-red-400"
        accentColor="border-l-red-500/50 focus:border-l-red-500/80"
        onSelect={() => onAnimateCommand?.(`/delete ${slug}`)}
        MenuItem={MenuItem}
      />
    </>
  );
}
