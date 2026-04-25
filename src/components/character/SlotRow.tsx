import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaItem } from "@/components/sidebar/types";

export interface SlotRowProps {
  label: string;
  items: MediaItem[];
  emptyHint?: string;
  /** When set, the add tile renders as a wider labeled button instead of a plain "+". */
  addLabel?: string;
  onAdd: () => void;
  onSelect: (assetId: string) => void;
  onUnpin: (assetId: string) => void;
}

export function SlotRow({ label, items, emptyHint, addLabel, onAdd, onSelect, onUnpin }: SlotRowProps) {
  return (
    <div className="border-t border-zinc-700/40 px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[9px] font-mono uppercase tracking-wider text-violet-300/70">{label}</span>
        <span className="text-[9px] font-mono text-violet-400/40">{items.length}</span>
      </div>
      <div className="flex gap-1.5 overflow-x-auto items-stretch">
        {items.map((it) => (
          <SlotTile key={it.id} item={it} onSelect={onSelect} onUnpin={onUnpin} />
        ))}
        {addLabel ? (
          <button
            type="button"
            onClick={onAdd}
            aria-label={`Add to ${label}`}
            className={cn(
              "shrink-0 h-16 px-3 rounded border border-dashed flex items-center gap-1.5 transition-colors",
              "border-violet-400/60 text-violet-100 bg-violet-500/10 hover:bg-violet-500/25 hover:border-violet-300",
            )}
          >
            <Plus className="w-4 h-4" />
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider whitespace-nowrap">
              {addLabel}
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onAdd}
            aria-label={`Add to ${label}`}
            className={cn(
              "shrink-0 w-16 h-16 rounded border border-dashed flex flex-col items-center justify-center gap-0.5 transition-colors",
              "border-violet-500/30 text-violet-300/60 hover:border-violet-300 hover:text-violet-100 hover:bg-violet-500/10",
            )}
          >
            <Plus className="w-4 h-4" />
            {items.length === 0 && emptyHint ? (
              <span className="text-[8px] font-mono uppercase tracking-wider">{emptyHint}</span>
            ) : null}
          </button>
        )}
      </div>
    </div>
  );
}

function SlotTile({
  item,
  onSelect,
  onUnpin,
}: {
  item: MediaItem;
  onSelect: (assetId: string) => void;
  onUnpin: (assetId: string) => void;
}) {
  const thumb = item.thumbnailSrc || item.filePath;
  return (
    <div className="group relative shrink-0 w-16 h-16">
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        title={item.slug}
        className={cn(
          "w-full h-full rounded border border-violet-500/20 overflow-hidden bg-black",
          "hover:border-violet-300 transition-colors",
        )}
      >
        {thumb ? (
          <img src={thumb} alt={item.title} className="w-full h-full object-cover" draggable={false} />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[8px] font-mono text-violet-400/60 px-1 text-center">
            {item.slug}
          </div>
        )}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onUnpin(item.id);
        }}
        aria-label={`Unpin ${item.slug}`}
        className={cn(
          "absolute -top-1 -right-1 w-4 h-4 rounded-full bg-zinc-900 border border-violet-400/40 text-violet-200",
          "opacity-0 group-hover:opacity-100 hover:bg-red-500/40 hover:border-red-400 transition-opacity",
          "flex items-center justify-center",
        )}
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}
