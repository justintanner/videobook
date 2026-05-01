import { useEffect, useMemo, useState } from 'react';
import { Loader2, Send, Share2, X, Calendar, Image as ImageIcon, Film } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import type { UseMcpResult } from 'use-mcp/react';

const MAX_TEXT = 280;

type Platform = 'x' | 'instagram';

interface PostComposerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: MediaItem | null;
  initialText: string;
  projectSlug: string | undefined;
  callTool: UseMcpResult['callTool'];
}

interface ToolTextResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

function extractText(result: unknown): string | null {
  const r = result as ToolTextResult;
  if (!r || !Array.isArray(r.content) || r.content.length === 0) return null;
  const first = r.content[0];
  return typeof first.text === 'string' ? first.text : null;
}

function localDatetimeNowPlus(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PostComposerDialog({
  open,
  onOpenChange,
  item,
  initialText,
  projectSlug,
  callTool,
}: PostComposerDialogProps) {
  const [text, setText] = useState(initialText);
  const [platform, setPlatform] = useState<Platform>('x');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledFor, setScheduledFor] = useState(() => localDatetimeNowPlus(30));
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ status: 'posted' | 'scheduled'; tweet_url?: string; scheduled_for?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setText(initialText);
    setScheduleEnabled(false);
    setScheduledFor(localDatetimeNowPlus(30));
    setResult(null);
    setError(null);
  }, [open, initialText, item?.id]);

  const charCount = text.length;
  const overLimit = charCount > MAX_TEXT;
  const hasMedia = !!item;
  const canSubmit = !submitting && hasMedia && !overLimit && !!projectSlug;

  const previewKind = useMemo(() => {
    if (!item) return null;
    if (item.type === 'video') return 'video' as const;
    if (item.type === 'image' || item.type === 'character') return 'image' as const;
    return null;
  }, [item]);

  const submit = async () => {
    if (!canSubmit || !item || !projectSlug) return;
    setSubmitting(true);
    setError(null);
    try {
      const args: Record<string, unknown> = {
        asset_id: item.id,
        project_slug: projectSlug,
        platform,
      };
      if (text.trim().length > 0) args.text = text.trim();
      if (scheduleEnabled) {
        const iso = new Date(scheduledFor).toISOString();
        args.scheduled_for = iso;
      }
      const res = await callTool('post', args);
      const r = res as ToolTextResult;
      if (r.isError) {
        setError(extractText(res) ?? 'Post failed');
        return;
      }
      const text0 = extractText(res);
      if (!text0) {
        setError('Empty response');
        return;
      }
      const parsed = JSON.parse(text0) as { status: 'posted' | 'scheduled'; tweet_url?: string; scheduled_for?: string };
      setResult(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const buttonLabel = scheduleEnabled ? 'Schedule' : 'Post now';
  const buttonIcon = scheduleEnabled ? <Calendar className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />;

  return (
    <div
      role="dialog"
      aria-label="Post composer"
      className="fixed inset-0 z-[101] bg-black/70 flex items-center justify-center p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onOpenChange(false); }}
    >
      <div className="w-full max-w-3xl max-h-[90vh] bg-zinc-950 border border-border/60 rounded-md shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 shrink-0">
          <div className="flex items-center gap-2 text-xs font-mono font-bold tracking-widest text-blue-300/80 uppercase">
            <Share2 className="w-3.5 h-3.5" />
            Post
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
          <div className="space-y-2">
            <div className="text-[10px] font-mono uppercase tracking-wider text-blue-300/70">Asset</div>
            {item && previewKind === 'video' && item.filePath ? (
              <video
                src={item.filePath}
                className="w-full aspect-video rounded border border-border/40 bg-black object-contain"
                controls
                muted
                playsInline
              />
            ) : item && previewKind === 'image' && (item.thumbnailSrc || item.filePath) ? (
              <img
                src={item.thumbnailSrc || item.filePath}
                alt={item.slug}
                className="w-full aspect-video rounded border border-border/40 bg-black object-contain"
              />
            ) : (
              <div className="w-full aspect-video rounded border border-dashed border-border/40 bg-black/40 flex flex-col items-center justify-center gap-1 text-[11px] font-mono text-muted-foreground">
                <ImageIcon className="w-5 h-5 opacity-50" />
                <span>No asset selected</span>
                <span className="text-[10px]">Run /post @vid-… or @img-…</span>
              </div>
            )}
            {item ? (
              <div className="text-[11px] font-mono text-blue-100/90 truncate flex items-center gap-1.5" title={item.slug}>
                {previewKind === 'video' ? <Film className="w-3 h-3" /> : <ImageIcon className="w-3 h-3" />}
                {item.slug}
              </div>
            ) : null}
          </div>

          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-mono uppercase tracking-wider text-blue-300/70">Text</label>
                <span className={cn(
                  'text-[10px] font-mono',
                  overLimit ? 'text-red-400' : charCount > MAX_TEXT * 0.85 ? 'text-amber-400' : 'text-muted-foreground',
                )}>
                  {charCount}/{MAX_TEXT}
                </span>
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                placeholder="What's happening?"
                className="w-full text-sm bg-black/40 border border-border/40 rounded px-3 py-2 outline-none focus:border-blue-400/60 resize-none font-mono"
              />
            </div>

            <div>
              <label className="text-[10px] font-mono uppercase tracking-wider text-blue-300/70 block mb-1">Platform</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPlatform('x')}
                  className={cn(
                    'flex-1 px-3 py-1.5 text-xs font-mono rounded border transition-colors',
                    platform === 'x'
                      ? 'border-blue-400/60 bg-blue-500/10 text-blue-100'
                      : 'border-border/40 text-muted-foreground hover:border-border/70',
                  )}
                >
                  X
                </button>
                <button
                  type="button"
                  disabled
                  title="Instagram support coming soon"
                  className="flex-1 px-3 py-1.5 text-xs font-mono rounded border border-border/30 text-muted-foreground/40 cursor-not-allowed"
                >
                  Instagram (soon)
                </button>
              </div>
            </div>

            <div>
              <label className="flex items-center gap-2 text-[11px] font-mono text-blue-200/90 cursor-pointer">
                <input
                  type="checkbox"
                  checked={scheduleEnabled}
                  onChange={(e) => setScheduleEnabled(e.target.checked)}
                  className="accent-blue-400"
                />
                Schedule for later
              </label>
              {scheduleEnabled ? (
                <input
                  type="datetime-local"
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                  min={localDatetimeNowPlus(1)}
                  className="mt-2 w-full text-sm bg-black/40 border border-border/40 rounded px-3 py-1.5 outline-none focus:border-blue-400/60 font-mono"
                />
              ) : null}
            </div>

            {error ? (
              <div className="text-[11px] font-mono text-red-300 bg-red-950/40 border border-red-500/30 rounded px-3 py-2 whitespace-pre-wrap">
                {error}
              </div>
            ) : null}
            {result ? (
              <div className="text-[11px] font-mono text-emerald-300 bg-emerald-950/30 border border-emerald-500/30 rounded px-3 py-2">
                {result.status === 'posted' ? (
                  <span>
                    Posted —{' '}
                    {result.tweet_url ? (
                      <a className="underline" href={result.tweet_url} target="_blank" rel="noreferrer">
                        view
                      </a>
                    ) : null}
                  </span>
                ) : (
                  <span>Scheduled for {result.scheduled_for ? new Date(result.scheduled_for).toLocaleString() : '...'}</span>
                )}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border/50 shrink-0">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-3 py-1.5 text-xs font-mono rounded border border-border/40 text-muted-foreground hover:text-foreground hover:border-border/70 transition-colors"
          >
            Close
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className={cn(
              'px-3 py-1.5 text-xs font-mono rounded border transition-colors flex items-center gap-1.5',
              canSubmit
                ? 'border-blue-400/60 bg-blue-500/20 text-blue-100 hover:bg-blue-500/30'
                : 'border-border/30 text-muted-foreground/50 cursor-not-allowed',
            )}
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : buttonIcon}
            {buttonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
