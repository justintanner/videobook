import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, LogIn, Send, Share2, X, Calendar, Image as ImageIcon, Film } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import type { UseMcpResult } from 'use-mcp/react';
import { usePromptHistory } from '@/hooks/usePromptHistory';
import { useSlashCommandPicker } from '@/hooks/useSlashCommandPicker';
import { PromptHistoryArrows } from '@/components/ui/PromptHistoryArrows';

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

interface XConnectStatus {
  connected: boolean;
  pending: boolean;
  has_credentials: boolean;
  error?: string;
  expires_at?: string;
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60_000;

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
  const [xStatus, setXStatus] = useState<XConnectStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const userPickedOrientationRef = useRef(false);
  const pollTimerRef = useRef<number | null>(null);
  const pollDeadlineRef = useRef<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const history = usePromptHistory(callTool, 'post', projectSlug);
  const slashPicker = useSlashCommandPicker({
    value: text,
    setValue: setText,
    textareaRef,
    onAfterDispatch: () => onOpenChange(false),
  });

  const fetchXStatus = useCallback(async (): Promise<XConnectStatus | null> => {
    try {
      const res = await callTool('x_connect_status', {});
      const r = res as ToolTextResult;
      if (r.isError) return null;
      const t = extractText(res);
      if (!t) return null;
      return JSON.parse(t) as XConnectStatus;
    } catch {
      return null;
    }
  }, [callTool]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const pollStatus = useCallback(async () => {
    pollTimerRef.current = null;
    if (Date.now() > pollDeadlineRef.current) {
      setConnecting(false);
      setConnectError('Timed out waiting for X authorization. Try again.');
      return;
    }
    const s = await fetchXStatus();
    if (s) {
      setXStatus(s);
      if (s.connected) {
        setConnecting(false);
        setConnectError(null);
        return;
      }
      if (s.error && !s.pending) {
        setConnecting(false);
        setConnectError(s.error);
        return;
      }
    }
    pollTimerRef.current = window.setTimeout(pollStatus, POLL_INTERVAL_MS);
  }, [fetchXStatus]);

  const connectX = useCallback(async () => {
    if (connecting) return;
    setConnectError(null);
    setConnecting(true);
    try {
      const res = await callTool('x_connect_start', {});
      const r = res as ToolTextResult;
      if (r.isError) {
        setConnectError(extractText(res) ?? 'Could not start X connect flow');
        setConnecting(false);
        return;
      }
      const t = extractText(res);
      if (!t) {
        setConnectError('Empty response from x_connect_start');
        setConnecting(false);
        return;
      }
      const parsed = JSON.parse(t) as { authorize_url: string };
      window.open(parsed.authorize_url, '_blank', 'noopener,noreferrer');
      pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
      pollTimerRef.current = window.setTimeout(pollStatus, POLL_INTERVAL_MS);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
      setConnecting(false);
    }
  }, [callTool, connecting, pollStatus]);

  useEffect(() => {
    if (!open) {
      stopPolling();
      setConnecting(false);
      setConnectError(null);
      return;
    }
    setText(initialText);
    setScheduleEnabled(false);
    setScheduledFor(localDatetimeNowPlus(30));
    setResult(null);
    setError(null);
    userPickedOrientationRef.current = false;
    setOrientation('portrait');
    history.reset();
    fetchXStatus().then((s) => {
      if (s) setXStatus(s);
    });
    return () => {
      stopPolling();
    };
    // `history` is recreated each render — reset is stable enough; deps below cover the trigger surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialText, item?.id, fetchXStatus, stopPolling]);

  const charCount = text.length;
  const overLimit = charCount > MAX_TEXT;
  const hasMedia = !!item;
  const needsXConnect = platform === 'x' && xStatus !== null && !xStatus.connected;
  const canSubmit = !submitting && hasMedia && !overLimit && !!projectSlug && !needsXConnect;

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
      const trimmedText = text.trim();
      const args: Record<string, unknown> = {
        asset_id: item.id,
        project_slug: projectSlug,
        platform,
      };
      if (trimmedText.length > 0) args.text = trimmedText;
      if (previewKind === 'video') args.orientation = orientation;
      if (scheduleEnabled) {
        const iso = new Date(scheduledFor).toISOString();
        args.scheduled_for = iso;
      }
      if (trimmedText.length > 0) {
        history.push(trimmedText, { platform });
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
                className={cn(
                  'w-full rounded border border-border/40 bg-black object-contain',
                  orientation === 'portrait' ? 'aspect-[9/16]' : 'aspect-video',
                )}
                controls
                muted
                playsInline
                onLoadedMetadata={(e) => {
                  if (userPickedOrientationRef.current) return;
                  const v = e.currentTarget;
                  if (v.videoWidth && v.videoHeight) {
                    setOrientation(v.videoHeight > v.videoWidth ? 'portrait' : 'landscape');
                  }
                }}
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
                <div className="flex items-center gap-2">
                  <PromptHistoryArrows
                    cursor={history.cursor}
                    total={history.entries.length}
                    onPrev={() => {
                      const prev = history.navigateBack(text);
                      if (prev !== null) setText(prev);
                    }}
                    onNext={() => {
                      const next = history.navigateForward();
                      if (next !== null) setText(next);
                    }}
                    colorClass="text-blue-300/70"
                  />
                  <span className={cn(
                    'text-[10px] font-mono',
                    overLimit ? 'text-red-400' : charCount > MAX_TEXT * 0.85 ? 'text-amber-400' : 'text-muted-foreground',
                  )}>
                    {charCount}/{MAX_TEXT}
                  </span>
                </div>
              </div>
              <div className="relative">
                {slashPicker.dropdown}
                <textarea
                  ref={textareaRef}
                  value={text}
                  onChange={(e) => { setText(e.target.value); history.reset(); }}
                  onKeyDown={(e) => {
                    if (slashPicker.onKeyDown(e)) return;
                    if (e.key === 'ArrowUp' && !e.shiftKey && (textareaRef.current?.selectionStart ?? 0) === 0) {
                      const prev = history.navigateBack(text);
                      if (prev !== null) { e.preventDefault(); setText(prev); }
                      return;
                    }
                    if (e.key === 'ArrowDown' && !e.shiftKey && history.cursor !== -1) {
                      const next = history.navigateForward();
                      if (next !== null) { e.preventDefault(); setText(next); }
                    }
                  }}
                  rows={6}
                  placeholder="What's happening?  (or /help)"
                  className="w-full text-sm bg-black/40 border border-border/40 rounded px-3 py-2 outline-none focus:border-blue-400/60 resize-none font-mono"
                />
              </div>
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

            {previewKind === 'video' ? (
              <div>
                <label className="text-[10px] font-mono uppercase tracking-wider text-blue-300/70 block mb-1">Orientation</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      userPickedOrientationRef.current = true;
                      setOrientation('portrait');
                    }}
                    className={cn(
                      'flex-1 px-3 py-1.5 text-xs font-mono rounded border transition-colors',
                      orientation === 'portrait'
                        ? 'border-blue-400/60 bg-blue-500/10 text-blue-100'
                        : 'border-border/40 text-muted-foreground hover:border-border/70',
                    )}
                  >
                    Portrait 9:16
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      userPickedOrientationRef.current = true;
                      setOrientation('landscape');
                    }}
                    className={cn(
                      'flex-1 px-3 py-1.5 text-xs font-mono rounded border transition-colors',
                      orientation === 'landscape'
                        ? 'border-blue-400/60 bg-blue-500/10 text-blue-100'
                        : 'border-border/40 text-muted-foreground hover:border-border/70',
                    )}
                  >
                    Landscape 16:9
                  </button>
                </div>
              </div>
            ) : null}

            {needsXConnect ? (
              <div className="text-[11px] font-mono text-amber-200 bg-amber-950/30 border border-amber-500/30 rounded px-3 py-2 flex items-center gap-2">
                <span className="flex-1">
                  {xStatus?.has_credentials === false
                    ? 'Set X_CLIENT_ID and X_CLIENT_SECRET in .env, then connect.'
                    : 'Sign in to X once — token auto-refreshes after that.'}
                </span>
                <button
                  type="button"
                  onClick={connectX}
                  disabled={connecting || xStatus?.has_credentials === false}
                  className={cn(
                    'px-2.5 py-1 text-xs font-mono rounded border flex items-center gap-1.5 transition-colors',
                    connecting || xStatus?.has_credentials === false
                      ? 'border-border/30 text-muted-foreground/50 cursor-not-allowed'
                      : 'border-amber-400/60 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30',
                  )}
                >
                  {connecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogIn className="w-3 h-3" />}
                  {connecting ? 'Waiting…' : 'Connect X'}
                </button>
              </div>
            ) : null}
            {connectError ? (
              <div className="text-[11px] font-mono text-red-300 bg-red-950/40 border border-red-500/30 rounded px-3 py-2 whitespace-pre-wrap">
                {connectError}
              </div>
            ) : null}

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
