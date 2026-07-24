import { useEffect, useState } from 'react';
import { Loader2, QrCode, Check } from 'lucide-react';
import { CloseButton } from '@/components/ui/CloseButton';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import type { UseMcpResult } from 'use-mcp/react';
import { OSG_POSITIONS, type OsgPosition } from '@/components/center-stage/render-settings-types';

export interface WatermarkApplyValue {
  targetId: string;
  handle: string;
  position: OsgPosition;
  scale: number;
  saveDefault: boolean;
}

interface WatermarkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: MediaItem | null;
  bookId: string | undefined;
  callTool: UseMcpResult['callTool'];
  onApply: (value: WatermarkApplyValue) => void;
}

interface ToolTextResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

interface WatermarkConfig {
  savedHandle: string | null;
  recent: string[];
  authenticatedHandle?: string | null;
}

function extractText(result: unknown): string | null {
  const r = result as ToolTextResult;
  if (!r || !Array.isArray(r.content) || r.content.length === 0) return null;
  const first = r.content[0];
  return typeof first.text === 'string' ? first.text : null;
}

const POSITION_LABEL: Record<OsgPosition, string> = {
  'top-left': 'Top left', 'top-center': 'Top center', 'top-right': 'Top right',
  'middle-left': 'Middle left', 'middle-center': 'Middle center', 'middle-right': 'Middle right',
  'bottom-left': 'Bottom left', 'bottom-center': 'Bottom center', 'bottom-right': 'Bottom right',
};

export function WatermarkDialog(props: WatermarkDialogProps) {
  if (!props.open) return null;
  const key = `${props.bookId ?? ''}:${props.item?.id ?? ''}`;
  return <WatermarkDialogContent key={key} {...props} />;
}

function WatermarkDialogContent({ onOpenChange, item, bookId, callTool, onApply }: WatermarkDialogProps) {
  const [handle, setHandle] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [position, setPosition] = useState<OsgPosition>('bottom-right');
  const [scale, setScale] = useState(1);
  const [saveDefault, setSaveDefault] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await callTool('get_watermark_config', {});
        const r = res as ToolTextResult;
        const text = r.isError ? null : extractText(res);
        const cfg = text ? (JSON.parse(text) as WatermarkConfig) : { savedHandle: null, recent: [], authenticatedHandle: null };
        if (cancelled) return;
        setRecent(cfg.recent ?? []);
        setHandle(cfg.savedHandle ?? cfg.authenticatedHandle ?? cfg.recent?.[0] ?? '');
      } catch {
        if (!cancelled) { setRecent([]); setHandle(''); }
      } finally {
        if (!cancelled) setLoadingConfig(false);
      }
    })();
    return () => { cancelled = true; };
  }, [callTool]);

  const cleanHandle = handle.trim().replace(/^@/, '');
  const canApply = !!item && !!bookId && cleanHandle.length > 0;

  const apply = () => {
    if (!canApply || !item) return;
    onApply({ targetId: item.id, handle: cleanHandle, position, scale, saveDefault });
    onOpenChange(false);
  };

  const previewSrc = item?.thumbnailSrc || item?.filePath || null;

  return (
    <div
      role="dialog"
      aria-label="Watermark"
      className="fixed inset-0 z-[101] bg-black/70 flex items-center justify-center p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onOpenChange(false); }}
    >
      <div className="w-full max-w-lg bg-zinc-950 border border-border/60 rounded-md shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 shrink-0">
          <div className="flex items-center gap-2 text-xs font-mono font-bold tracking-widest text-teal-300/80 uppercase">
 <QrCode className="size-3.5" />
            Watermark
          </div>
          <CloseButton onClick={() => onOpenChange(false)} tone="teal" />
        </div>

        <div className="p-4 flex flex-col gap-4">
          {/* Target preview */}
          <div className="flex items-center gap-3">
            {previewSrc ? (
 <img src={previewSrc} alt="" className="size-16 shrink-0 rounded border border-border/40 bg-black object-cover" />
            ) : (
 <div className="size-16 shrink-0 rounded border border-dashed border-border/40 bg-black/40" />
            )}
            <div className="min-w-0">
              <div className="text-[10px] font-mono uppercase tracking-wider text-teal-300/70">Applies to</div>
              <div className="text-sm font-mono text-teal-100/90 min-w-0 truncate" title={item?.slug}>
                {item?.slug ?? 'No video selected'}
              </div>
              <div className="text-[10px] font-mono text-muted-foreground">QR end-card over the last 2s</div>
            </div>
          </div>

          {/* Handle */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-mono uppercase tracking-wider text-teal-300/70 block">X handle</label>
            <div className="relative flex items-center">
              <span className="absolute left-2.5 text-sm font-mono text-muted-foreground">@</span>
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
                placeholder={loadingConfig ? 'Loading…' : 'yourhandle'}
                autoFocus
                className="w-full text-sm bg-black/40 border border-border/40 rounded pl-6 pr-3 py-2 outline-none focus:border-teal-400/60 font-mono"
              />
            </div>
            {recent.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <span className="text-[10px] font-mono text-muted-foreground/70 self-center">Recent:</span>
                {recent.map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setHandle(h)}
                    className={cn(
                      'px-2 py-0.5 text-[11px] font-mono rounded border transition-colors',
                      h.toLowerCase() === cleanHandle.toLowerCase()
                        ? 'border-teal-400/60 bg-teal-500/10 text-teal-100'
                        : 'border-border/40 text-muted-foreground hover:border-border/70',
                    )}
                  >
                    @{h}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Position + scale */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-mono uppercase tracking-wider text-teal-300/70 block">Position</label>
              <select
                value={position}
                onChange={(e) => setPosition(e.target.value as OsgPosition)}
                className="w-full text-sm bg-black/40 border border-border/40 rounded px-2 py-2 outline-none focus:border-teal-400/60 font-mono"
              >
                {OSG_POSITIONS.map((p) => (
                  <option key={p} value={p}>{POSITION_LABEL[p]}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-mono uppercase tracking-wider text-teal-300/70 block">
                Size <span className="text-muted-foreground/70">{scale.toFixed(2)}×</span>
              </label>
              <input
                type="range"
                min={0.25}
                max={2}
                step={0.05}
                value={scale}
                onChange={(e) => setScale(parseFloat(e.target.value))}
                className="w-full accent-teal-400 mt-2.5"
              />
            </div>
          </div>

          {/* Remember default */}
          <label className="flex items-center gap-2 text-[11px] font-mono text-teal-200/90 cursor-pointer">
            <input
              type="checkbox"
              checked={saveDefault}
              onChange={(e) => setSaveDefault(e.target.checked)}
              className="accent-teal-400"
            />
            Remember as my default handle
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border/50 shrink-0">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-3 py-1.5 text-xs font-mono rounded border border-border/40 text-muted-foreground hover:text-foreground hover:border-border/70 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!canApply}
            className={cn(
              'px-3 py-1.5 text-xs font-mono rounded border transition-colors flex items-center gap-1.5',
              canApply
                ? 'border-teal-400/60 bg-teal-500/20 text-teal-100 hover:bg-teal-500/30'
                : 'border-border/30 text-muted-foreground/50 cursor-not-allowed',
            )}
          >
 {loadingConfig ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
