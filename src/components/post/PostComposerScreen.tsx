import { useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, CheckCircle2, HelpCircle, Loader2, LogIn, Send, Share2, Calendar, Image as ImageIcon, Film, XCircle } from 'lucide-react';
import { CloseButton } from '@/components/ui/CloseButton';
import { ViewerToolbar } from '@/components/center-stage/viewer-shared';
import { cn } from '@/lib/utils';
import { extractXMentions } from '@/lib/x-mentions';
import type { MediaItem } from '@/components/sidebar/types';
import type { UseMcpResult } from 'use-mcp/react';
import { usePromptHistory } from '@/hooks/usePromptHistory';
import { useSlashCommandPicker } from '@/hooks/useSlashCommandPicker';
import { useVerifyMentions, type MentionVerdict } from '@/hooks/useVerifyMentions';
import { useXConnect } from '@/hooks/useXConnect';
import { PromptHistoryArrows } from '@/components/ui/PromptHistoryArrows';

const MAX_TEXT = 280;

interface PostComposerScreenProps {
  item: MediaItem | null;
  initialText: string;
  bookId: string | undefined;
  callTool: UseMcpResult['callTool'];
  onClose: () => void;
}

interface ToolTextResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

function MentionChip({ verdict }: { verdict: MentionVerdict }) {
  const label = verdict.exists === true
    ? (verdict.display_name ? `@${verdict.handle} — ${verdict.display_name}` : `@${verdict.handle}`)
    : verdict.exists === false
      ? `@${verdict.handle} not found`
      : `@${verdict.handle} unverified`;
  const Icon = verdict.exists === true ? CheckCircle2 : verdict.exists === false ? XCircle : HelpCircle;
  const chip = (
    <span
      className={cn(
        'px-2 py-1 text-[11px] font-mono rounded border flex items-center gap-1.5',
        verdict.exists === true
          ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
          : verdict.exists === false
            ? 'border-red-500/40 bg-red-950/30 text-red-300'
            : 'border-amber-500/40 bg-amber-950/30 text-amber-200',
      )}
      title={verdict.summary ?? undefined}
    >
 <Icon className="size-3 shrink-0" />
      <span className="min-w-0 truncate max-w-[240px]">{label}</span>
    </span>
  );
  if (verdict.exists !== true) return chip;
  return (
    <a href={`https://x.com/${verdict.handle}`} target="_blank" rel="noreferrer" className="no-underline">
      {chip}
    </a>
  );
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

export function PostComposerScreen({
  item,
  initialText,
  bookId,
  callTool,
  onClose,
}: PostComposerScreenProps) {
  const [text, setText] = useState(initialText);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledFor, setScheduledFor] = useState(() => localDatetimeNowPlus(30));
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ status: 'posted' | 'scheduled'; tweet_url?: string; scheduled_for?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const userPickedOrientationRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const history = usePromptHistory(callTool, 'post', bookId);
  const mentionCheck = useVerifyMentions(callTool, bookId);
  const mentions = useMemo(() => extractXMentions(text), [text]);
  const mentionVerdicts = useMemo(
    () => mentionCheck.verdicts.filter((verdict) =>
      mentions.some((handle) => handle.toLowerCase() === verdict.handle.toLowerCase())),
    [mentionCheck.verdicts, mentions],
  );
  const slashPicker = useSlashCommandPicker({
    value: text,
    setValue: setText,
    textareaRef,
    onAfterDispatch: onClose,
  });

  const { status: xStatus, connecting, connectError, connect: connectX, fetchStatus: fetchXStatus, reset: resetXConnect } = useXConnect(callTool);

  useEffect(() => {
    void fetchXStatus();
    return resetXConnect;
  }, [fetchXStatus, resetXConnect]);

  const charCount = text.length;
  const overLimit = charCount > MAX_TEXT;
  const hasMedia = !!item;
  const needsXConnect = xStatus !== null && !xStatus.connected;
  const canSubmit = !submitting && hasMedia && !overLimit && !!bookId && !needsXConnect;

  const previewKind = useMemo(() => {
    if (!item) return null;
    if (item.type === 'video' || item.type === 'final') return 'video' as const;
    if (item.type === 'image') return 'image' as const;
    return null;
  }, [item]);

  const submit = async () => {
    if (!canSubmit || !item || !bookId) return;
    setSubmitting(true);
    setError(null);
    try {
      const trimmedText = text.trim();
      const args: Record<string, unknown> = {
        asset_id: item.id,
        book_id: bookId,
        platform: 'x',
      };
      if (trimmedText.length > 0) args.text = trimmedText;
      if (previewKind === 'video') args.orientation = orientation;
      if (scheduleEnabled) {
        const iso = new Date(scheduledFor).toISOString();
        args.scheduled_for = iso;
      }
      if (trimmedText.length > 0) {
        history.push(trimmedText, { platform: 'x' });
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

  const buttonLabel = scheduleEnabled ? 'Schedule' : 'Post now';
 const buttonIcon = scheduleEnabled ? <Calendar className="size-3.5" /> : <Send className="size-3.5" />;

  return (
    <div className="flex-1 min-w-0 flex items-center justify-center overflow-hidden">
 <div className="size-full min-w-0 relative bg-zinc-950">
        <div className="absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
          <ViewerToolbar
            left={
              <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-bold tracking-widest text-blue-300/80 uppercase">
 <Share2 className="size-3.5" />
                <span>POST</span>
              </span>
            }
            slug={item?.slug ?? 'no asset'}
            right={<CloseButton onClick={onClose} />}
          />

          <div className="flex-1 min-h-0 overflow-y-auto p-6">
            <div className="min-h-full grid grid-cols-1 md:grid-cols-[minmax(320px,1fr)_minmax(360px,560px)] gap-8 items-center">
              <div className="flex flex-col gap-2">
                <div className="text-[10px] font-mono uppercase tracking-wider text-blue-300/70">Asset</div>
                {item && previewKind === 'video' && item.filePath ? (
                  <video
                    src={item.filePath}
                    poster={item.thumbnailSrc || undefined}
                    className={cn(
                      'w-full max-h-[70vh] rounded border border-border/40 bg-black object-contain',
                      orientation === 'portrait' ? 'aspect-[9/16]' : 'aspect-video',
                    )}
                    controls
                    muted
                    playsInline
                    preload="metadata"
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
 <ImageIcon className="size-5 opacity-50" />
                    <span>No asset selected</span>
                    <span className="text-[10px]">Run /post @vid-… or @img-…</span>
                  </div>
                )}
                {item ? (
                  <div className="flex items-center min-w-0 gap-1.5 text-[11px] font-mono text-blue-100/90" title={item.slug}>
 {previewKind === 'video' ? <Film className="size-3 shrink-0" /> : <ImageIcon className="size-3 shrink-0" />}
                    <span className="min-w-0 truncate">{item.slug}</span>
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
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

                {mentions.length > 0 || mentionCheck.status === 'error' ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => void mentionCheck.verify(text)}
                        disabled={mentionCheck.status === 'checking' || mentions.length === 0}
                        className={cn(
                          'px-2.5 py-1 text-[11px] font-mono rounded border flex items-center gap-1.5 transition-colors',
                          mentionCheck.status === 'checking' || mentions.length === 0
                            ? 'border-border/30 text-muted-foreground/50 cursor-not-allowed'
                            : 'border-blue-400/60 bg-blue-500/10 text-blue-100 hover:bg-blue-500/20',
                        )}
                      >
                        {mentionCheck.status === 'checking'
 ? <Loader2 className="size-3 animate-spin" />
 : <AtSign className="size-3" />}
                        Verify mentions
                      </button>
                      {mentionVerdicts.map((verdict) => (
                        <MentionChip key={verdict.handle.toLowerCase()} verdict={verdict} />
                      ))}
                    </div>
                    {mentionCheck.status === 'error' ? (
                      <div className="text-[11px] font-mono text-red-300 bg-red-950/40 border border-red-500/30 rounded px-3 py-2 whitespace-pre-wrap">
                        {mentionCheck.error}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-mono uppercase tracking-wider text-blue-300/70 block">Platform</label>
                  <div className="flex gap-2">
                    <span className="px-6 py-1.5 text-xs font-mono rounded border border-blue-400/60 bg-blue-500/10 text-blue-100">
                      X
                    </span>
                  </div>
                </div>

                {previewKind === 'video' ? (
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-mono uppercase tracking-wider text-blue-300/70 block">Orientation</label>
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
 {connecting ? <Loader2 className="size-3 animate-spin" /> : <LogIn className="size-3" />}
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

                <div className="flex items-center justify-end pt-1">
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!canSubmit}
                    className={cn(
                      'px-4 py-1.5 text-xs font-mono rounded border transition-colors flex items-center gap-1.5',
                      canSubmit
                        ? 'border-blue-400/60 bg-blue-500/20 text-blue-100 hover:bg-blue-500/30'
                        : 'border-border/30 text-muted-foreground/50 cursor-not-allowed',
                    )}
                  >
 {submitting ? <Loader2 className="size-3.5 animate-spin" /> : buttonIcon}
                    {buttonLabel}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
