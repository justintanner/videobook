import { Upload, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface UploadSlotProps {
  onClick?: () => void;
  loading?: boolean;
}

export function UploadSlot({ onClick, loading }: UploadSlotProps) {

  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onClick}
      disabled={loading}
      className={cn(
        'w-full aspect-video flex flex-col items-center justify-center gap-2',
        'border-2 border-dashed border-border/50 rounded-md',
        'text-xs font-mono text-muted-foreground',
        'transition-colors cursor-pointer',
        'hover:border-primary/50 hover:text-primary',
        loading && 'pointer-events-none opacity-60',
      )}
    >
      {loading ? (
        <>
 <Loader2 className="size-5 animate-spin" />
          <span>UPLOADING...</span>
        </>
      ) : (
        <>
 <Upload className="size-5" />
          <span>/upload</span>
        </>
      )}
    </button>
  );
}
