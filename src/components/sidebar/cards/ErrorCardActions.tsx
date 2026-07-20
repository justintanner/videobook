import { RotateCcw, X } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { MediaItem } from '../types';

interface ErrorCardActionsProps {
  item: MediaItem;
  /** Fires when the user recovers a failed card. The consumer clears the
   *  asset's persisted error (recover_asset) and re-syncs, returning it to
   *  ready while preserving any intact media. */
  onRecover?: (item: MediaItem) => void;
  onDelete?: (item: MediaItem) => void;
}

/**
 * Hover-revealed Recover / Delete controls for an error-state card. Rendered
 * by each card type only when `item.status === 'error'`; the parent decides
 * which handlers (if any) to wire. Renders nothing when neither handler is
 * supplied.
 */
export function ErrorCardActions({ item, onRecover, onDelete }: ErrorCardActionsProps) {
  if (!onRecover && !onDelete) return null;
  return (
    <div className="absolute top-1 right-1 z-50 hidden group-hover:flex items-center gap-1">
      {onRecover && (
        <button
          type="button"
          onClick={(e: ReactMouseEvent) => {
            e.stopPropagation();
            onRecover(item);
          }}
          aria-label={`Recover ${item.slug}`}
          title="Recover (clear error, keep media)"
 className="flex items-center justify-center size-5 rounded-sm bg-emerald-500/80 hover:bg-emerald-500 text-white transition-colors"
        >
 <RotateCcw className="size-3" />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={(e: ReactMouseEvent) => {
            e.stopPropagation();
            onDelete(item);
          }}
          aria-label={`Delete ${item.slug}`}
          title="Delete asset"
 className="flex items-center justify-center size-5 rounded-sm bg-red-500/80 hover:bg-red-500 text-white transition-colors"
        >
 <X className="size-3" />
        </button>
      )}
    </div>
  );
}
