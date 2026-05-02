import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Settings, FileText, Loader2, X, Copy, Zap, Images, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/useToast';
import { ToastAction } from '@/components/ui/toast';
import type { MediaItem } from '@/components/sidebar/types';
import { useMountKey } from '@/contexts/MountKeyContext';
import type { UseMcpResult } from 'use-mcp/react';
import type { BackTab } from './viewer-types';
import {
  ViewerToolbar,
  BackFaceTabBar,
  FilesBackPane,
  HistoryBackPane,
  useViewerBackFace,
} from './viewer-shared';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import { AutocompleteDropdown } from '@/components/ui/AutocompleteDropdown';
import type { AutocompleteItem, ColorScheme } from '@/components/ui/AutocompleteDropdown';
import { useRewriteScript } from '@/hooks/useRewriteScript';
import { RewritePopover, type RewriteInitial } from './RewritePopover';
import { useEstimateCost, type EstimateCall } from '@/hooks/useEstimateCost';
import { CostBadge } from '@/components/cost/CostBadge';

const GEN_IMAGES_FAN_OUT_TOOLS: readonly string[] = [
  'generate_nano_banana_pro_fal',
  'generate_wan27_pro_fal',
  'generate_seedream_v5_lite_fal',
  'generate_grok_imagine_image_fal',
];
import { useScriptHistoryNav } from '@/hooks/useScriptHistoryNav';
import { useAssetOriginalMeta } from '@/hooks/useAssetOriginalMeta';
import { LastRewriteChip } from './LastRewriteChip';
import type { RewriteMeta } from '@/hooks/useAssetHistory';

// ── ScriptViewer ──

const SCRIPT_BACK_TABS: BackTab[] = ['files', 'history'];

const COMMAND_COLORS: Record<string, ColorScheme> = {
  action: 'cyan',
  project: 'amber',
  context_menu: 'violet',
  viewer: 'cyan',
  editor: 'cyan',
};

const AUTOSAVE_DEBOUNCE_MS = 800;

/** Extract the current line text up to cursor position */
function getCurrentLineAtCursor(text: string, cursorPos: number): { line: string; lineStart: number } {
  const lineStart = text.lastIndexOf('\n', cursorPos - 1) + 1;
  return { line: text.slice(lineStart, cursorPos), lineStart };
}

export function ScriptViewer({ item, projectSlug, flipped, onFlippedChange, pendingFilePosition, onClearPendingFilePosition, pendingBackTab, onClearPendingBackTab, callTool, onClose }: {
  item: MediaItem;
  projectSlug: string;
  flipped: boolean;
  onFlippedChange: (f: boolean) => void;
  pendingFilePosition?: number | null;
  onClearPendingFilePosition?: () => void;
  pendingBackTab?: BackTab | null;
  onClearPendingBackTab?: () => void;
  callTool: UseMcpResult['callTool'];
  onClose: () => void;
}) {
  useMountKey('viewer');

  const { dispatch, commands } = useCommandDispatch();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [draft, setDraft] = useState(item.prompt ?? '');
  const [saving, setSaving] = useState(false);
  const isDirty = draft !== (item.prompt ?? '');
  const dirtyRef = useRef(isDirty);
  dirtyRef.current = isDirty;

  // Slash command autocomplete state
  const [cursorPos, setCursorPos] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // Detect slash trigger on the current line
  const slashTrigger = useMemo(() => {
    const { line } = getCurrentLineAtCursor(draft, cursorPos);
    const match = line.match(/^\/([\w-]*)$/);
    if (!match) return null;
    return { filter: match[1] };
  }, [draft, cursorPos]);

  // Build autocomplete items: registry commands only
  const autocompleteItems = useMemo((): AutocompleteItem[] => {
    if (!slashTrigger) return [];
    const filter = slashTrigger.filter.toLowerCase();

    return commands
      .filter((c) => c.command.slice(1).toLowerCase().includes(filter))
      .map((c) => ({
        type: 'command' as const,
        value: c.command,
        label: c.command,
        description: c.description,
        example: c.example,
        category: c.category,
        icon: c.icon,
        colorScheme: (COMMAND_COLORS[c.category] ?? 'cyan') as ColorScheme,
      }));
  }, [slashTrigger, commands]);

  const showSuggestions = slashTrigger !== null && autocompleteItems.length > 0 && !dismissed;

  // Reset selectedIndex and dismissed when trigger changes
  const prevFilter = useRef<string | null>(null);
  const currentFilter = slashTrigger?.filter ?? null;
  if (currentFilter !== prevFilter.current) {
    prevFilter.current = currentFilter;
    if (dismissed) setDismissed(false);
    if (selectedIndex !== 0) setSelectedIndex(0);
  }

  // Track item changes — autosave effect below flushes any pending edit before the switch.
  const prevItemId = useRef(item.id);
  useEffect(() => {
    if (item.id !== prevItemId.current) {
      prevItemId.current = item.id;
      setDraft(item.prompt ?? '');
    }
  }, [item.id, item.prompt]);

  // Sync draft when item.prompt updates externally (e.g. after save + sync)
  // but only when not dirty
  useEffect(() => {
    if (!dirtyRef.current) {
      setDraft(item.prompt ?? '');
    }
  }, [item.prompt]);

  // beforeunload protection
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Script history navigation — Prev/Next instantly restore HEAD one step back/forward
  const historyNav = useScriptHistoryNav({ callTool, assetId: item.id, projectSlug });

  // Last-rewrite metadata (model/variant/platform/customPrompt) from .original.json
  const { meta: lastRewrite, refresh: refreshLastRewrite } = useAssetOriginalMeta(
    callTool,
    item.id,
    projectSlug,
  );

  // Pre-filled args when user clicks the chip or "Use this prompt" in history.
  const [pendingRewriteArgs, setPendingRewriteArgs] = useState<RewriteInitial | null>(null);

  const guardedPrev = useCallback(() => {
    void historyNav.prev();
  }, [historyNav]);

  // Rewrite handler — invokes rewrite_script with variant + optional platform/customPrompt
  const { rewrite, rewriting } = useRewriteScript(callTool);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const handleRewriteSubmit = useCallback(
    (args: { variant: 'full' | 'tldr'; platform?: 'ig' | 'tiktok' | 'youtube'; customPrompt?: string }) => {
      setRewriteOpen(false);
      setPendingRewriteArgs(null);
      // Clear dirty state before kicking off the rewrite so the overlay →
      // new-prompt transition stays clean.
      setDraft(item.prompt ?? '');
      void rewrite(item.id, projectSlug, args);
    },
    [rewrite, item.id, item.prompt, projectSlug],
  );

  const openRewriteWith = useCallback((meta: Pick<RewriteMeta, 'variant' | 'platform' | 'customPrompt'>) => {
    setPendingRewriteArgs({
      variant: meta.variant,
      platform: meta.platform,
      customPrompt: meta.customPrompt,
    });
    setRewriteOpen(true);
  }, []);

  const handleReuseFromHistory = useCallback((meta: RewriteMeta) => {
    onFlippedChange(false);
    openRewriteWith(meta);
  }, [onFlippedChange, openRewriteWith]);

  const handleRewriteOpenChange = useCallback((open: boolean) => {
    setRewriteOpen(open);
    if (!open) setPendingRewriteArgs(null);
  }, []);

  // Recently-saved indicator — drives the toolbar chip for ~1.5s after a save.
  const [justSaved, setJustSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Silent save used by autosave, blur, ⌘S, and Undo.
  // Returns the prior value (from `item.prompt` at call time) so callers can build an Undo toast.
  const savingRef = useRef(false);
  const saveNow = useCallback(async (content: string, options?: { showUndoToast?: boolean }): Promise<string | null> => {
    if (savingRef.current) return null;
    const prior = item.prompt ?? '';
    if (content === prior) return null;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await callTool('update_script', {
        asset_id: item.id,
        content,
        project_slug: projectSlug,
      });
      if (result.isError) {
        const msg = result.content?.[0]?.type === 'text' ? result.content[0].text : 'Save failed';
        toast({ title: 'Save failed', description: msg, duration: 4000 });
        return null;
      }
      await callTool('sync', { project_slug: projectSlug });
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      setJustSaved(true);
      savedTimerRef.current = setTimeout(() => setJustSaved(false), 1500);
      if (options?.showUndoToast !== false) {
        toast({
          title: 'Saved',
          duration: 4000,
          action: (
            <ToastAction
              altText="Undo save"
              onClick={() => {
                // Reset the draft first so the autosave effect doesn't re-dirty the doc
                // the moment the revert-save completes.
                setDraft(prior);
                void saveNow(prior, { showUndoToast: false });
              }}
            >
              Undo
            </ToastAction>
          ),
        });
      }
      return prior;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [callTool, item.id, item.prompt, projectSlug]);

  // Debounced autosave on draft change
  const isGeneratingRef = useRef(false);
  useEffect(() => {
    if (!isDirty || isGeneratingRef.current) return;
    const handle = setTimeout(() => { void saveNow(draft); }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [draft, isDirty, saveNow]);

  // Cmd+S / Ctrl+S — flush immediately
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (dirtyRef.current) void saveNow(draft);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [saveNow, draft]);

  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  // GEN IMAGES handler — fan out the script's prompt across leading t2i models
  const [genInFlight, setGenInFlight] = useState(false);
  const handleGenImages = useCallback(async () => {
    if (genInFlight) return;
    const prompt = (item.prompt ?? '').trim();
    if (!prompt) {
      toast({ title: 'Script is empty', description: 'Write a prompt first', duration: 2500 });
      return;
    }
    // Autosave keeps item.prompt current; if there's an in-flight draft, flush it first.
    if (isDirty) await saveNow(draft, { showUndoToast: false });
    setGenInFlight(true);
    try {
      const result = await callTool('gen_images_all_models', {
        prompt,
        project_slug: projectSlug,
        source_script_id: item.id,
      });
      if (result.isError) {
        const msg = result.content?.[0]?.type === 'text' ? result.content[0].text : 'Gen images failed';
        toast({ title: 'Gen images failed', description: msg, duration: 4000 });
        return;
      }
      toast({ title: 'Image jobs queued', description: '5 models', duration: 2000 });
      await callTool('sync', { project_slug: projectSlug });
    } finally {
      setGenInFlight(false);
    }
  }, [genInFlight, isDirty, draft, saveNow, callTool, item.id, item.prompt, projectSlug]);

  const promptText = (item.prompt ?? '').trim();

  const rewriteEstimateCalls = useMemo<EstimateCall[] | null>(() => {
    if (!promptText) return null;
    return [{ toolName: 'rewrite_script', input: { script_text: promptText } }];
  }, [promptText]);
  const rewriteCost = useEstimateCost(callTool, { calls: rewriteEstimateCalls });

  const genImagesEstimateCalls = useMemo<EstimateCall[] | null>(() => {
    if (!promptText) return null;
    return GEN_IMAGES_FAN_OUT_TOOLS.map((toolName) => ({
      toolName,
      input: { prompt: promptText },
    }));
  }, [promptText]);
  const genImagesCost = useEstimateCost(callTool, { calls: genImagesEstimateCalls });

  const isGenerating = rewriting || item.status === 'generating';
  const rewriteDisabled = isGenerating;
  isGeneratingRef.current = isGenerating;

  // Refresh last-rewrite metadata and force-sync the textarea after a rewrite completes.
  // item.prompt gets replaced externally, which would otherwise flip isDirty to true
  // (because draft still holds the pre-rewrite text) and block the regular sync effect.
  const wasGenerating = useRef(isGenerating);
  useEffect(() => {
    if (wasGenerating.current && !isGenerating) {
      refreshLastRewrite();
      setDraft(item.prompt ?? '');
    }
    wasGenerating.current = isGenerating;
  }, [isGenerating, refreshLastRewrite, item.prompt]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(draft).then(
      () => toast({ title: 'Copied', description: item.slug, duration: 2000 }),
      () => toast({ title: 'Error', description: 'Failed to copy', duration: 2500 }),
    );
  }, [draft, item.slug]);

  // Strip the current /command line from the draft
  const stripCommandLine = useCallback(() => {
    const pos = textareaRef.current?.selectionStart ?? cursorPos;
    const { lineStart } = getCurrentLineAtCursor(draft, pos);
    // Find line end
    let lineEnd = draft.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = draft.length;
    // Remove the line (and trailing newline if present)
    const before = draft.slice(0, lineStart);
    const after = draft.slice(lineEnd + 1); // +1 to eat the \n
    const newDraft = before + after;
    setDraft(newDraft);
    // Restore cursor to line start
    setTimeout(() => {
      textareaRef.current?.setSelectionRange(lineStart, lineStart);
    }, 0);
  }, [draft, cursorPos]);

  const executeCommand = useCallback((commandValue: string) => {
    stripCommandLine();
    dispatch(commandValue);
  }, [stripCommandLine, dispatch]);

  // Select an autocomplete suggestion
  const selectSuggestion = useCallback((acItem: AutocompleteItem) => {
    executeCommand(acItem.value);
    setDismissed(true);
  }, [executeCommand]);

  // Track cursor position
  const updateCursorPos = useCallback(() => {
    const pos = textareaRef.current?.selectionStart ?? 0;
    setCursorPos(pos);
  }, []);

  // Handle keyboard in the textarea
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showSuggestions) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % autocompleteItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + autocompleteItems.length) % autocompleteItems.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectSuggestion(autocompleteItems[selectedIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
    }
  }, [showSuggestions, autocompleteItems, selectedIndex, selectSuggestion]);

  const bf = useViewerBackFace({
    projectSlug,
    itemId: item.id,
    callTool,
    flipped,
    onFlippedChange,
    pendingFilePosition,
    onClearPendingFilePosition,
    pendingBackTab,
    onClearPendingBackTab,
    defaultBackTab: 'files',
  });

  // Flip to back — autosave runs in the background, no confirm needed.
  const { handleFlipToBack: bfFlip } = bf;
  const handleFlipToBack = useCallback(() => {
    if (isDirty) void saveNow(draft, { showUndoToast: false });
    bfFlip();
  }, [isDirty, draft, saveNow, bfFlip]);

  return (
    <div className="flex-1 flex items-center justify-center overflow-hidden">
      <div className="flip-card-perspective w-full h-full">
        <div className={cn(
          'flip-card-inner w-full h-full relative',
          flipped && 'flipped',
        )}>
          {/* FRONT FACE */}
          <div className={cn(
            'flip-card-face absolute inset-0 flex flex-col overflow-hidden',
            'border border-zinc-600/50',
          )}>
            <ViewerToolbar
              left={
                <span className="flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-bold text-primary/90 drop-shadow-[0_0_4px_rgba(0,255,255,0.5)]">
                  <FileText className="w-3.5 h-3.5" />
                  <span>MARKDOWN</span>
                  {saving && (
                    <span className="flex items-center gap-1 text-yellow-400/80 text-[10px]">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Saving…
                    </span>
                  )}
                  {!saving && justSaved && (
                    <span className="flex items-center gap-1 text-emerald-400/90 text-[10px]">
                      <Check className="w-3 h-3" />
                      Saved
                    </span>
                  )}
                  {!saving && !justSaved && isDirty && (
                    <span className="text-yellow-400/60 text-[10px]">editing…</span>
                  )}
                </span>
              }
              slug={item.slug}
              right={
                <div className="flex items-center gap-1">
                  <button
                    tabIndex={-1}
                    onClick={handleFlipToBack}
                    title="/files"
                    className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
                  >
                    <Settings className="w-4 h-4 stroke-[2.5]" />
                  </button>
                  <button
                    tabIndex={-1}
                    onClick={onClose}
                    title="Close"
                    className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors duration-150 rounded hover:bg-primary/10"
                  >
                    <X className="w-4 h-4 stroke-[2.5]" />
                  </button>
                </div>
              }
            />

            <div className="flex-1 bg-black flex flex-col min-h-0 relative">
              {/* Inner toolbar — Rewrite + TLDR + Copy above the markdown body */}
              <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-zinc-800/60 bg-black/40 z-10">
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={handleGenImages}
                  disabled={genInFlight || saving || !(item.prompt ?? '').trim()}
                  title="Generate image across 5 leading t2i models (Nano Banana Pro, Wan 2.7 Pro, Seedream, GPT Image 1.5, Grok Imagine)"
                  className={cn(
                    'h-7 px-2.5 flex items-center gap-1.5 rounded',
                    'text-[11px] font-mono font-bold uppercase tracking-wider',
                    'text-cyan-300/90 hover:text-cyan-200',
                    'bg-cyan-500/5 hover:bg-cyan-500/15 border border-cyan-500/30 hover:border-cyan-400/60',
                    'transition-colors duration-150',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                  )}
                >
                  {genInFlight
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Images className="w-3.5 h-3.5" />}
                  Gen Images
                </button>
                <CostBadge
                  estimate={genImagesCost.estimate}
                  loading={genImagesCost.loading}
                  error={genImagesCost.error}
                  stale={genImagesCost.stale}
                  onRefresh={genImagesCost.refresh}
                />
                <RewritePopover
                  open={rewriteOpen}
                  onOpenChange={handleRewriteOpenChange}
                  onSubmit={handleRewriteSubmit}
                  rewriting={rewriting}
                  initial={pendingRewriteArgs}
                  callTool={callTool}
                  projectSlug={projectSlug}
                  trigger={
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setRewriteOpen((o) => !o)}
                      disabled={rewriteDisabled || saving}
                      title="Rewrite script (TLDR/Full, optional platform preset + instruction)"
                      className={cn(
                        'h-7 px-2.5 flex items-center gap-1.5 rounded',
                        'text-[11px] font-mono font-bold uppercase tracking-wider',
                        'text-amber-300/90 hover:text-amber-200',
                        'bg-amber-500/5 hover:bg-amber-500/15 border border-amber-500/30 hover:border-amber-400/60',
                        'transition-colors duration-150',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                        rewriteOpen && 'bg-amber-500/15 border-amber-400/60 text-amber-200',
                      )}
                    >
                      {rewriting
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Zap className="w-3.5 h-3.5" />}
                      Rewrite
                    </button>
                  }
                />
                <CostBadge
                  estimate={rewriteCost.estimate}
                  loading={rewriteCost.loading}
                  error={rewriteCost.error}
                  stale={rewriteCost.stale}
                  onRefresh={rewriteCost.refresh}
                />

                <div className="ml-auto flex items-center gap-1">
                  {/* PREV / NEXT — one click, instantly restore HEAD one step back/forward */}
                  <div className="flex items-center rounded overflow-hidden border border-violet-500/30">
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={guardedPrev}
                      disabled={!historyNav.canPrev || historyNav.loading || isGenerating}
                      title="Restore previous version"
                      className={cn(
                        'h-7 w-7 flex items-center justify-center',
                        'text-violet-300/90 hover:text-violet-200',
                        'bg-violet-500/5 hover:bg-violet-500/15',
                        'transition-colors duration-150',
                        'disabled:opacity-40 disabled:cursor-not-allowed',
                      )}
                    >
                      {historyNav.loading
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <ChevronLeft className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => { void historyNav.next(); }}
                      disabled={!historyNav.canNext || historyNav.loading || isGenerating}
                      title="Restore next version"
                      className={cn(
                        'h-7 w-7 flex items-center justify-center border-l border-violet-500/30',
                        'text-violet-300/90 hover:text-violet-200',
                        'bg-violet-500/5 hover:bg-violet-500/15',
                        'transition-colors duration-150',
                        'disabled:opacity-40 disabled:cursor-not-allowed',
                      )}
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={handleCopy}
                    title="Copy markdown"
                    className={cn(
                      'h-7 px-2.5 flex items-center gap-1.5 rounded',
                      'text-[11px] font-mono font-bold uppercase tracking-wider',
                      'text-zinc-300/90 hover:text-zinc-100',
                      'bg-zinc-500/5 hover:bg-zinc-500/15 border border-zinc-500/30 hover:border-zinc-400/60',
                      'transition-colors duration-150',
                    )}
                  >
                    <Copy className="w-3.5 h-3.5" />
                    Copy
                  </button>
                </div>
              </div>

              {/* Last-rewrite metadata chip — click to re-run with the same args */}
              {lastRewrite && !isGenerating && (
                <LastRewriteChip meta={lastRewrite} onClick={openRewriteWith} />
              )}

              <div className="flex-1 flex min-h-0 relative">
                {/* CRT scanlines — behind the text, ≤20% opacity so glyphs stay sharp */}
                <div className="absolute inset-0 scanlines pointer-events-none opacity-20 z-0" />

                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); updateCursorPos(); }}
                  onKeyDown={handleKeyDown}
                  onKeyUp={updateCursorPos}
                  onClick={updateCursorPos}
                  onSelect={updateCursorPos}
                  onBlur={() => { if (dirtyRef.current) void saveNow(draft, { showUndoToast: false }); }}
                  disabled={isGenerating}
                  placeholder="Write your script here..."
                  className={cn(
                    'relative z-10 w-full h-full resize-none px-8 py-6',
                    'bg-transparent',
                    'text-[15px] leading-7 tracking-[0.01em] text-sky-300 placeholder:text-sky-300/25 caret-sky-200',
                    'font-mono',
                    'focus:outline-none',
                    'overflow-y-auto scrollbar-cyan',
                    isGenerating && 'opacity-40 cursor-not-allowed select-none',
                  )}
                />

                {isGenerating && (
                  <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
                    {/* Dim backdrop so stale content reads as stale */}
                    <div className="absolute inset-0 bg-black/60" />
                    {/* CRT scanlines on top of the dim — matches the sidebar card's green generating state */}
                    <div
                      className="absolute inset-0 pointer-events-none opacity-40"
                      style={{
                        background: `repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(34,197,94,0.06) 2px, rgba(34,197,94,0.06) 4px)`,
                      }}
                    />
                    <div className="relative flex flex-col items-center gap-3">
                      <div
                        className="px-3 py-1.5 flex items-center gap-2 border rounded"
                        style={{
                          color: '#22c55e',
                          borderColor: 'rgba(34,197,94,0.6)',
                          backgroundColor: 'rgba(34,197,94,0.12)',
                          boxShadow: '0 0 12px rgba(34,197,94,0.35)',
                          textShadow: '0 0 8px #22c55e',
                          animation: 'generating-model-pulse 2s ease-in-out infinite',
                        }}
                      >
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-[11px] font-mono font-bold uppercase tracking-[0.18em]">
                          Rewriting Script
                        </span>
                      </div>
                      <div className="flex gap-0.5">
                        {[0, 1, 2, 3, 4].map((i) => (
                          <div
                            key={i}
                            className="w-5 h-1.5 border"
                            style={{
                              borderColor: 'rgba(34,197,94,0.45)',
                              animation: 'generating-segment-fill 2.5s ease-in-out infinite',
                              animationDelay: `${i * 0.4}s`,
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Slash command autocomplete */}
              {showSuggestions && (
                <div className="absolute bottom-12 right-3 w-72">
                  <AutocompleteDropdown
                    items={autocompleteItems}
                    selectedIndex={selectedIndex}
                    onSelect={selectSuggestion}
                    onHover={setSelectedIndex}
                  />
                </div>
              )}

            </div>
          </div>

          {/* BACK FACE */}
          <div className="flip-card-back absolute inset-0 flex flex-col overflow-hidden border border-zinc-600/50">
            <BackFaceTabBar
              tabs={SCRIPT_BACK_TABS}
              active={bf.backTab}
              onSelect={bf.setBackTab}
              slug={item.slug}
              onClose={() => onFlippedChange(false)}
              onCloseViewer={onClose}
            />

            {bf.backTab === 'files' ? (
              <FilesBackPane
                manifest={bf.manifest}
                manifestLoading={bf.manifestLoading}
                selectedFile={bf.selectedFile}
                fileContent={bf.fileContent}
                fileLoading={bf.fileLoading}
                fileUrl={bf.fileUrl}
                handleSelectFile={bf.handleSelectFile}
                handleFileKeyDown={bf.handleFileKeyDown}
                fetchManifest={bf.fetchManifest}
                fetchFileContent={bf.fetchFileContent}
              />
            ) : (
              <HistoryBackPane
                commits={bf.commits}
                historyLoading={bf.historyLoading}
                selectedCommitHash={bf.selectedCommitHash}
                setSelectedCommitHash={bf.setSelectedCommitHash}
                handleRestore={bf.handleRestore}
                fetchHistory={bf.fetchHistory}
                onReusePrompt={handleReuseFromHistory}
                itemId={item.id}
                projectSlug={projectSlug}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
