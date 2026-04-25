import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';

interface AssetMenuProps {
  slug: string;
  filePath?: string;
  itemType?: string;
  onAnimateCommand?: (text: string) => void;
  onAnimateEdit?: (text: string) => void;
  onExtractSkeleton?: () => void;
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

export function AssetMenu({ slug, filePath, itemType, onAnimateCommand, onAnimateEdit, onExtractSkeleton, MenuItem }: AssetMenuProps) {
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
          <CommandMenuItem
            command={`/describe ${slug}`}
            title="Describe Image"
            titleClassName="text-emerald-400"
            accentColor="border-l-emerald-500/50 focus:border-l-emerald-500/80"
            onSelect={() => onAnimateCommand?.(`/describe ${slug}`)}
            MenuItem={MenuItem}
          />
          <div className="-mx-1 my-1 h-px bg-border" />
          <CommandMenuItem
            command={`/character ${slug}`}
            title="Character"
            titleClassName="text-violet-300"
            accentColor="border-l-violet-400/50 focus:border-l-violet-400/80"
            onSelect={() => onAnimateCommand?.(`/character ${slug}`)}
            MenuItem={MenuItem}
          />
          <div className="-mx-1 my-1 h-px bg-border" />
          <CommandMenuItem
            command={`/outfit ${slug}`}
            title="Outfit"
            titleClassName="text-violet-400"
            accentColor="border-l-violet-500/50 focus:border-l-violet-500/80"
            onSelect={() => onAnimateCommand?.(`/outfit ${slug}`)}
            MenuItem={MenuItem}
          />
          {onExtractSkeleton && (
            <>
              <div className="-mx-1 my-1 h-px bg-border" />
              <CommandMenuItem
                command={`extract pose ${slug}`}
                title="Extract Pose Skeleton"
                titleClassName="text-amber-400"
                accentColor="border-l-amber-500/50 focus:border-l-amber-500/80"
                onSelect={onExtractSkeleton}
                MenuItem={MenuItem}
              />
            </>
          )}
          <div className="-mx-1 my-1 h-px bg-border" />
          {filePath && (
            <>
              <CommandMenuItem
                command="/copy-image"
                title="Copy Image"
                onSelect={() => {
                  const imgUrl = filePath.replace(/\?.*$/, '');
                  fetch(imgUrl)
                    .then((res) => res.blob())
                    .then((blob) => {
                      const img = new Image();
                      img.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.naturalWidth;
                        canvas.height = img.naturalHeight;
                        canvas.getContext('2d')!.drawImage(img, 0, 0);
                        canvas.toBlob((pngBlob) => {
                          if (!pngBlob) {
                            toast({ title: 'Error', description: 'Failed to convert image', duration: 3000 });
                            return;
                          }
                          navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]).then(
                            () => toast({ title: 'Copied', description: 'Image copied to clipboard', duration: 2000 }),
                            () => toast({ title: 'Error', description: 'Failed to copy image', duration: 3000 }),
                          );
                        }, 'image/png');
                      };
                      img.src = URL.createObjectURL(blob);
                    })
                    .catch(() => toast({ title: 'Error', description: 'Failed to fetch image', duration: 3000 }));
                }}
                MenuItem={MenuItem}
              />
              <div className="-mx-1 my-1 h-px bg-border" />
            </>
          )}
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
      {(itemType === 'video' || itemType === 'image') && (
        <>
          <div className="-mx-1 my-1 h-px bg-border" />
          <CommandMenuItem
            command={`/export ${slug}`}
            title="Export to Downloads"
            onSelect={() => onAnimateCommand?.(`/export ${slug}`)}
            MenuItem={MenuItem}
          />
        </>
      )}
      <div className="-mx-1 my-1 h-px bg-border" />
      <CommandMenuItem
        command="/folder"
        title="Show in Folder"
        onSelect={() => onAnimateCommand?.(`/folder ${slug}`)}
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
            command={`/copy-video ${slug}`}
            title="Copy Video"
            onSelect={() => onAnimateCommand?.(`/copy-video ${slug}`)}
            MenuItem={MenuItem}
          />
          <div className="-mx-1 my-1 h-px bg-border" />
          <CommandMenuItem
            command={`/video ${slug}`}
            title="Extend Video"
            titleClassName="text-fuchsia-400"
            accentColor="border-l-fuchsia-500/50 focus:border-l-fuchsia-500/80"
            onSelect={() => onAnimateCommand?.(`/video ${slug}`)}
            MenuItem={MenuItem}
          />
          <div className="-mx-1 my-1 h-px bg-border" />
          <CommandMenuItem
            command={`/trim ${slug}`}
            title="Trim Video"
            onSelect={() => onAnimateCommand?.(`/trim ${slug}`)}
            MenuItem={MenuItem}
          />
          <div className="-mx-1 my-1 h-px bg-border" />
          <CommandMenuItem
            command={`/extract-first-frame ${slug}`}
            title="Extract First Frame"
            titleClassName="text-blue-400"
            accentColor="border-l-blue-500/50 focus:border-l-blue-500/80"
            onSelect={() => onAnimateCommand?.(`/extract-first-frame ${slug}`)}
            MenuItem={MenuItem}
          />
          <div className="-mx-1 my-1 h-px bg-border" />
          <CommandMenuItem
            command={`/extract-last-frame ${slug}`}
            title="Extract Last Frame"
            titleClassName="text-blue-400"
            accentColor="border-l-blue-500/50 focus:border-l-blue-500/80"
            onSelect={() => onAnimateCommand?.(`/extract-last-frame ${slug}`)}
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
