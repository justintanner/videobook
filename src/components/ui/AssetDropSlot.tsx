import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ImageIcon, Video, Music, X, Plus } from 'lucide-react';
import { sectionTheme } from '@/theme/domains';

interface ResolvedAsset {
  id?: string;
  slug: string;
  src: string;
  thumbnailSrc?: string | null;
  type: 'image' | 'video' | 'audio' | 'character';
}

interface AssetDropSlotProps {
  value: ResolvedAsset | null;
  onChange: (asset: ResolvedAsset | null) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  acceptTypes?: ('image' | 'video' | 'audio' | 'character')[];
  emptyIcon?: React.ReactNode;
  compact?: boolean;
  variant?: 'image' | 'video';
}

// Theme tokens. Sourced from the canonical 5-domain palette in
// src/theme/domains.ts.
const imageTheme = sectionTheme('image');
const videoTheme = sectionTheme('video');

const themes = {
  image: {
    controlBorder: imageTheme.controlBorder,
    controlBg: imageTheme.controlBg,
    controlText: imageTheme.controlText,
    activeBorder: imageTheme.activeBorder,
    activeText: imageTheme.activeText,
    activeGlow: imageTheme.activeGlow,
    inactiveText: imageTheme.inactiveText,
    inactiveHoverBorder: imageTheme.inactiveHoverBorder,
    labelText: imageTheme.labelText,
  },
  video: {
    controlBorder: videoTheme.controlBorder,
    controlBg: videoTheme.controlBg,
    controlText: videoTheme.controlText,
    activeBorder: videoTheme.activeBorder,
    activeText: videoTheme.activeText,
    activeGlow: videoTheme.activeGlow,
    inactiveText: videoTheme.inactiveText,
    inactiveHoverBorder: videoTheme.inactiveHoverBorder,
    labelText: videoTheme.labelText,
  },
} as const;

export function AssetDropSlot({ value, onChange, disabled, acceptTypes = ['image'], emptyIcon, compact, variant = 'image' }: AssetDropSlotProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const isVideoOnly = acceptTypes.length === 1 && acceptTypes[0] === 'video';
  const isAudioOnly = acceptTypes.length === 1 && acceptTypes[0] === 'audio';
  const t = themes[variant];
  const thumbUrl = value?.thumbnailSrc || value?.src || '';
  const hasThumb = !!thumbUrl && brokenUrl !== thumbUrl;

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (disabled) return;
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled) return;

    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'));
      if (data && acceptTypes.includes(data.type)) {
        onChange({
          id: data.id,
          slug: data.slug,
          src: data.filePath || data.src,
          thumbnailSrc: data.thumbnailSrc,
          type: data.type,
        });
      }
    } catch {
      // Invalid drop data
    }
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
  };

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded border transition-all duration-200',
        compact ? 'h-10' : 'aspect-video',
        t.controlBg,
        disabled && 'opacity-30 pointer-events-none',
        isDragOver && !disabled
          ? cn(t.activeBorder, 'border-solid')
          : value
            ? cn(t.controlBorder, 'border-solid')
            : cn(t.controlBorder, 'border-dashed', t.inactiveHoverBorder),
      )}
      style={isDragOver ? { boxShadow: t.activeGlow } : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {value ? (
        <>
          {compact ? (
            <div className="w-full h-full flex items-center gap-2 px-2">
              {hasThumb && (
                <img
                  src={thumbUrl}
                  alt=""
                  draggable={false}
                  onError={() => setBrokenUrl(thumbUrl)}
                  className="h-6 w-6 object-contain shrink-0"
                />
              )}
              <span className={cn('text-xs font-mono truncate', t.labelText)}>{value.slug}</span>
            </div>
          ) : value.type === 'audio' ? (
            <div className="w-full h-full flex flex-col items-center justify-center gap-1">
              <Music className={cn('w-5 h-5', t.activeText)} />
              <span className={cn('text-xs font-mono truncate px-2', t.labelText)}>{value.slug}</span>
            </div>
          ) : hasThumb ? (
            <>
              <img
                src={thumbUrl}
                alt=""
                draggable={false}
                onError={() => setBrokenUrl(thumbUrl)}
                className="w-full h-full object-cover"
              />
              <div className="absolute bottom-1 left-1 right-1 z-10 flex justify-start">
                <span className={cn(
                  'max-w-full text-[10px] font-mono font-bold truncate px-1.5 py-0.5 rounded',
                  'bg-black/85 backdrop-blur-md border',
                  variant === 'video' ? 'text-violet-300' : 'text-cyan-300',
                )}
                style={{
                  borderColor: variant === 'video' ? 'rgba(167,139,250,0.4)' : 'rgba(34,211,238,0.2)',
                }}>
                  {value.slug}
                </span>
              </div>
            </>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-1 px-2">
              <ImageIcon className={cn('w-5 h-5', t.inactiveText)} />
              <span className={cn('text-xs font-mono truncate max-w-full', t.labelText)}>{value.slug}</span>
            </div>
          )}

          {/* Clear button */}
          {!disabled && (
            <button
              onClick={handleClear}
              className={cn(
                'absolute top-1 right-1 w-5 h-5 rounded flex items-center justify-center transition-colors',
                t.controlBg, t.controlBorder, 'border',
                'hover:bg-red-500/30 hover:border-red-500/60',
              )}
            >
              <X className={cn('w-3 h-3', t.controlText)} />
            </button>
          )}
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
          <div className={cn('transition-all duration-200', isDragOver ? cn(t.activeText, 'scale-110') : t.inactiveText)}>
            {isDragOver ? (
              <Plus className="w-5 h-5" />
            ) : emptyIcon ? (
              emptyIcon
            ) : isAudioOnly ? (
              <Music className="w-5 h-5" />
            ) : isVideoOnly ? (
              <Video className="w-5 h-5" />
            ) : (
              <ImageIcon className="w-5 h-5" />
            )}
          </div>
          <span className={cn('text-[10px] font-mono font-bold tracking-widest', t.inactiveText)}>
            DROP
          </span>
        </div>
      )}
    </div>
  );
}
