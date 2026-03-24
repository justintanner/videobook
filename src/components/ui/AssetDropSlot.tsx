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

// Theme tokens matching RenderSettingsPanel's ThemedDropSlot
const themes = {
  default: {
    controlBorder: 'border-cyan-500/15',
    controlBg: 'bg-cyan-500/[0.04]',
    controlText: 'text-cyan-400/40',
    activeBorder: 'border-cyan-400',
    activeText: 'text-cyan-300',
    activeGlow: '0 0 12px rgba(34,211,238,0.25)',
    inactiveText: 'text-cyan-400/25',
    inactiveHoverBorder: 'hover:border-cyan-500/30',
    labelText: 'text-cyan-400/50',
  },
  violet: {
    controlBorder: 'border-violet-500/15',
    controlBg: 'bg-violet-500/[0.04]',
    controlText: 'text-violet-400/40',
    activeBorder: 'border-violet-400',
    activeText: 'text-violet-300',
    activeGlow: '0 0 12px rgba(139,92,246,0.25)',
    inactiveText: 'text-violet-400/25',
    inactiveHoverBorder: 'hover:border-violet-500/30',
    labelText: 'text-violet-400/50',
  },
} as const;

export function AssetDropSlot({ value, onChange, disabled, acceptTypes = ['image'], emptyIcon, compact, variant = 'default' }: AssetDropSlotProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const isVideoOnly = acceptTypes.length === 1 && acceptTypes[0] === 'video';
  const t = themes[variant];

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
              {(value.thumbnailSrc || value.src) && (
                <img src={value.thumbnailSrc || value.src} alt={value.slug} draggable={false} className="h-6 w-6 object-contain shrink-0" />
              )}
              <span className={cn('text-xs font-mono truncate', t.labelText)}>{value.slug}</span>
            </div>
          ) : (value.thumbnailSrc || value.src) ? (
            <img
              src={value.thumbnailSrc || value.src}
              alt={value.slug}
              draggable={false}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className={cn('text-xs font-mono truncate px-2', t.labelText)}>{value.slug}</span>
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
