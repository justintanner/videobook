import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaItem } from "@/components/sidebar/types";

export interface AssetPickerModalProps {
  open: boolean;
  title: string;
  assets: MediaItem[];
  excludeIds?: string[];
  onPick: (assetId: string) => void;
  onClose: () => void;
}

export function AssetPickerModal({ open, title, assets, excludeIds, onPick, onClose }: AssetPickerModalProps) {
  const [query, setQuery] = useState("");
  const excludeSet = useMemo(() => new Set(excludeIds ?? []), [excludeIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets
      .filter((a) => !excludeSet.has(a.id))
      .filter((a) => {
        if (!q) return true;
        return (
          a.slug.toLowerCase().includes(q) ||
          a.title.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q)
        );
      });
  }, [assets, excludeSet, query]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label={title}
      className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[80vh] bg-zinc-950 border border-cyan-500/40 rounded-lg shadow-xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-cyan-500/30 shrink-0">
          <div className="text-xs font-mono font-bold tracking-widest text-cyan-200 uppercase">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close picker"
            className="text-cyan-300/70 hover:text-cyan-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-2 border-b border-cyan-500/20 shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-cyan-400/60" />
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search slugs, titles…"
              className={cn(
                "w-full bg-black/60 border border-cyan-500/20 rounded pl-7 pr-2 py-1.5 text-xs font-mono text-cyan-100",
                "focus:border-cyan-400/60 focus:outline-none focus:ring-1 focus:ring-cyan-400/40",
              )}
            />
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {filtered.length === 0 ? (
            <div className="text-cyan-300/60 text-xs font-mono py-8 text-center">No matching assets.</div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {filtered.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => onPick(it.id)}
                  className={cn(
                    "group relative aspect-square rounded border border-cyan-500/20 overflow-hidden bg-black",
                    "hover:border-cyan-300 transition-colors",
                  )}
                  title={it.slug}
                >
                  {it.thumbnailSrc || it.filePath ? (
                    <img
                      src={it.thumbnailSrc ?? it.filePath}
                      alt={it.title}
                      className="w-full h-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[10px] font-mono text-cyan-400/60 px-2 text-center">
                      {it.slug}
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1 text-[9px] font-mono text-cyan-100 truncate">
                    {it.slug}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
