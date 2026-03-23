import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ImageIcon, Video, X, Plus } from 'lucide-react';

interface ResolvedAsset {
  id?: string;
  slug: string;
  src: string;
  thumbnailSrc?: string | null;
  type: 'image' | 'video';
}

interface AssetDropSlotProps {
  value: ResolvedAsset | null;
  onChange: (asset: ResolvedAsset | null) => void;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  acceptTypes?: ('image' | 'video')[];
  emptyIcon?: React.ReactNode;
  compact?: boolean;
  variant?: 'default' | 'violet';
}

export function AssetDropSlot({ value, onChange, disabled, acceptTypes = ['image'], emptyIcon, compact, variant = 'default' }: AssetDropSlotProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const isVideoOnly = acceptTypes.length === 1 && acceptTypes[0] === 'video';

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
        'relative overflow-hidden',
        compact ? 'h-10' : 'aspect-video',
        'border-2 transition-all duration-200',
        'bg-black/60',
        // States
        isDragOver && !disabled
          ? variant === 'violet'
            ? 'border-violet-400 border-solid shadow-[0_0_20px_rgba(139,92,246,0.5)] scale-[1.02]'
            : 'border-primary border-solid shadow-[0_0_20px_rgba(0,255,255,0.5)] scale-[1.02]'
          : value
            ? variant === 'violet' ? 'border-violet-400/50 border-solid' : 'border-primary/50 border-solid'
            : variant === 'violet' ? 'border-violet-400/30 border-dashed hover:border-violet-400/50' : 'border-primary/30 border-dashed hover:border-primary/50',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Scanlines overlay */}
      <div className="absolute inset-0 scanlines pointer-events-none opacity-20" />

      {value ? (
        <>
          {compact ? (
            <div className="w-full h-full flex items-center gap-2 px-2 bg-black/80">
              {(value.thumbnailSrc || value.src) && (
                <img src={value.thumbnailSrc || value.src} alt={value.slug} draggable={false} className="h-6 w-6 object-contain shrink-0" />
              )}
              <span className="text-xs font-mono text-primary/60 truncate">{value.slug}</span>
            </div>
          ) : (value.thumbnailSrc || value.src) ? (
            <img
              src={value.thumbnailSrc || value.src}
              alt={value.slug}
              draggable={false}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-black/80">
              <span className="text-xs font-mono text-primary/60 truncate px-2">{value.slug}</span>
            </div>
          )}

          {/* Clear button */}
          {!disabled && (
            <button
              onClick={handleClear}
              className={cn(
                'absolute top-1 right-1 w-5 h-5 rounded',
                'bg-black/70 border border-primary/30',
                'flex items-center justify-center',
                'hover:bg-red-500/30 hover:border-red-500/60 transition-colors'
              )}
            >
              <X className="w-3 h-3 text-primary/70" />
            </button>
          )}
        </>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          {/* Minimal drop icon */}
          <div className={cn('transition-all duration-200', isDragOver ? (variant === 'violet' ? 'text-violet-400 scale-110' : 'text-primary scale-110') : (variant === 'violet' ? 'text-violet-400/25' : 'text-primary/25'))}>
            {isDragOver ? (
              <Plus className="w-6 h-6" />
            ) : emptyIcon ? (
              emptyIcon
            ) : isVideoOnly ? (
              <Video className="w-5 h-5" />
            ) : (
              <ImageIcon className="w-5 h-5" />
            )}
          </div>
        </div>
      )}

      {/* Slot ready pulse animation when empty */}
      {!value && !isDragOver && <div className="absolute inset-0 pointer-events-none showcase-slot-ready" />}
    </div>
  );
}
