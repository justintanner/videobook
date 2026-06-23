// Full-screen char_swap flow-graph editor — mirrors the Trim editor shell
// (backdrop + dialog overlay, two-phase open animation, Escape to close,
// ChatInput pinned to the bottom). Reads its own plan via read_plan, holds the
// sidecar locally, owns the shared actions hook (so chat commands and node
// buttons drive the same gens), and renders PlanFlowCanvas in the body.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatInput } from '@/components/ui/ChatInput';
import { CloseButton } from '@/components/ui/CloseButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import { sourceAspectFromDimensions } from '@/lib/plan-aspect';
import type { UseMcpResult } from 'use-mcp/react';
import type { MediaItem } from '@/components/sidebar/types';
import { PlanFlowCanvas } from './PlanFlowCanvas';
import { useCharSwapActions } from './useCharSwapActions';
import { ALL_SWAP_MODELS, type PlanSidecar, type SwapModel, type VideoModel } from './charSwapModel';

interface PlanFlowEditorProps {
  open: boolean;
  onClose: () => void;
  mediaItems: MediaItem[];
  projectSlug: string | undefined;
  callTool: UseMcpResult['callTool'];
  assetSlugs: string[];
}

const EMPTY_SIDECAR: PlanSidecar = {
  scenes: [],
  characters: [],
  total_duration_s: 0,
  max_scene_seconds: 0,
  source_asset_id: '',
  model: '',
};

// Fingerprint of the per-frame wiring across all scenes — used to detect when a
// background auto-match job has written new frame_characters.
function frameCharsSignature(sc: PlanSidecar | null): string {
  if (!sc) return '';
  return sc.scenes.map((s) => JSON.stringify(s.frame_characters ?? null)).join('|');
}

// Whether any frame in the plan has explicit character wiring yet.
function planHasWiring(sc: PlanSidecar | null): boolean {
  if (!sc) return false;
  return sc.scenes.some((s) => (s.frame_characters?.image1?.length ?? 0) > 0 || (s.frame_characters?.image2?.length ?? 0) > 0);
}

// Map a chat-command model token (short code or full name) to a SwapModel.
function parseSwapModel(token: string | undefined): SwapModel {
  if (!token) return 'nano-banana-pro';
  const t = token.toLowerCase();
  if (t === 'nbp') return 'nano-banana-pro';
  if (t === 'gi2') return 'gpt-image-2';
  if (t === 'wan') return 'wan-2-7-image-pro';
  const full = ALL_SWAP_MODELS.find((m) => m === t);
  return full ?? 'nano-banana-pro';
}

export function PlanFlowEditor({ open, onClose, mediaItems, projectSlug, callTool, assetSlugs }: PlanFlowEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sidecar, setSidecar] = useState<PlanSidecar | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [matching, setMatching] = useState(false);
  const cancelledRef = useRef(false);
  const matchPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { dispatch: contextDispatch, commands: contextCommands } = useCommandDispatch();

  // Two-phase open: mount then animate in.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => setVisible(true), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setVisible(false), 0);
    return () => clearTimeout(t);
  }, [open]);

  // Load the plan when the overlay opens. Only char_swap is supported here.
  useEffect(() => {
    if (!open || !projectSlug) return;
    cancelledRef.current = false;
    setLoading(true);
    setUnsupported(false);
    void (async () => {
      const result = await callTool('read_plan', { project_slug: projectSlug });
      if (cancelledRef.current) return;
      if (result.isError) {
        setSidecar(null);
        setLoading(false);
        return;
      }
      try {
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        const parsed = JSON.parse(text) as PlanSidecar & { formula?: string };
        if (parsed.formula && parsed.formula !== 'char_swap') {
          setSidecar(null);
          setUnsupported(true);
        } else {
          setSidecar(parsed);
        }
      } catch {
        setSidecar(null);
      } finally {
        if (!cancelledRef.current) setLoading(false);
      }
    })();
    return () => { cancelledRef.current = true; };
  }, [open, projectSlug, callTool]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const sourceItem = useMemo(
    () => (sidecar?.source_asset_id ? mediaItems.find((m) => m.id === sidecar.source_asset_id) ?? null : null),
    [sidecar?.source_asset_id, mediaItems],
  );
  const sourceAspect = useMemo(
    () => sourceAspectFromDimensions(sourceItem?.width, sourceItem?.height),
    [sourceItem?.width, sourceItem?.height],
  );

  // Always call the actions hook (hooks can't be conditional); it no-ops on the
  // empty sidecar until the plan loads.
  const activeSidecar = sidecar ?? EMPTY_SIDECAR;
  const actions = useCharSwapActions({
    sidecar: activeSidecar,
    mediaItems,
    projectSlug: projectSlug ?? '',
    sourceAspect,
    callTool,
    onSidecarUpdate: setSidecar,
  });

  // Vision auto-match: enqueue the job, then poll read_plan until the wiring
  // changes (the job writes frame_characters in the background). Triggered from
  // the header button — an explicit user action, not an effect.
  const runAutoMatch = useCallback(async () => {
    if (!projectSlug || matching) return;
    const before = frameCharsSignature(sidecar);
    setMatching(true);
    const enqueued = await actions.matchCharacters();
    if (!enqueued) { setMatching(false); return; }
    let tries = 0;
    const poll = async () => {
      tries += 1;
      const r = await callTool('read_plan', { project_slug: projectSlug });
      if (cancelledRef.current) { setMatching(false); return; }
      if (!r.isError) {
        try {
          const parsed = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text) as PlanSidecar & { formula?: string };
          if ((!parsed.formula || parsed.formula === 'char_swap') && frameCharsSignature(parsed) !== before) {
            setSidecar(parsed);
            setMatching(false);
            return;
          }
        } catch {
          // keep polling
        }
      }
      if (tries >= 24) { setMatching(false); return; }
      matchPollRef.current = setTimeout(() => { void poll(); }, 3000);
    };
    matchPollRef.current = setTimeout(() => { void poll(); }, 3000);
  }, [projectSlug, matching, sidecar, actions, callTool]);

  // Stop any in-flight poll when the overlay closes / unmounts.
  useEffect(() => {
    if (open) return;
    if (matchPollRef.current) { clearTimeout(matchPollRef.current); matchPollRef.current = null; }
    setMatching(false);
  }, [open]);
  useEffect(() => () => { if (matchPollRef.current) clearTimeout(matchPollRef.current); }, []);

  const anyWired = useMemo(() => planHasWiring(sidecar), [sidecar]);

  const handleSend = useCallback(async (message: string): Promise<boolean> => {
    const raw = message.trim();
    const cmd = raw.toLowerCase();
    if (cmd === '/close') { onClose(); return true; }
    if (cmd === '/match') { void runAutoMatch(); return true; }

    // /run scene <n> frame <1|2> [model]
    let m = /^\/run\s+scene\s+(\d+)\s+frame\s+([12])(?:\s+(\S+))?$/.exec(cmd);
    if (m) {
      const sceneIndex = parseInt(m[1], 10) - 1;
      const frameIndex = (parseInt(m[2], 10) as 1 | 2);
      void actions.runSwap(sceneIndex, frameIndex, 'kie', parseSwapModel(m[3]));
      return true;
    }
    // /run video <n>
    m = /^\/run\s+video\s+(\d+)$/.exec(cmd);
    if (m) {
      const sceneIndex = parseInt(m[1], 10) - 1;
      void actions.runVideo(sceneIndex, 'seedance-2-ref' as VideoModel, '');
      return true;
    }
    // /fanout scene <n> frame <1|2> <m1,m2,...>
    m = /^\/fanout\s+scene\s+(\d+)\s+frame\s+([12])\s+(\S+)$/.exec(cmd);
    if (m) {
      const sceneIndex = parseInt(m[1], 10) - 1;
      const frameIndex = (parseInt(m[2], 10) as 1 | 2);
      const models = m[3].split(',').map((t) => parseSwapModel(t.trim()));
      void (async () => {
        for (const model of models) await actions.runSwap(sceneIndex, frameIndex, 'kie', model);
      })();
      return true;
    }
    return contextDispatch(message);
  }, [actions, contextDispatch, onClose, runAutoMatch]);

  if (!open) return null;

  const placeholder = 'type /match, /run scene 1 frame 1 [nbp|gi2|wan], /run video 1, /fanout scene 1 frame 1 nbp,wan…';

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] transition-opacity duration-300',
          visible ? 'opacity-100' : 'opacity-0',
        )}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Plan graph"
        className={cn(
          'fixed inset-0 z-[101] bg-zinc-950 flex flex-col transition-all duration-300',
          visible ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
        )}
      >
        <div className="h-12 shrink-0 flex items-center justify-between px-5 border-b border-zinc-700/60 bg-gradient-to-r from-zinc-900 via-zinc-900/95 to-zinc-950 relative">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs tracking-widest text-emerald-300/80 uppercase">Plan Graph · Char Swap</span>
            {sidecar && sidecar.scenes.length > 0 && (
              <button
                type="button"
                onClick={() => { void runAutoMatch(); }}
                disabled={matching}
                title="Vision-match which character belongs in each frame, then wire it up"
                className={cn(
                  'flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-mono border transition-colors',
                  matching
                    ? 'border-violet-500/40 text-violet-300/70 cursor-wait'
                    : anyWired
                      ? 'border-zinc-700 text-zinc-300 hover:border-violet-500/60 hover:text-violet-200'
                      : 'border-violet-500/60 text-violet-200 bg-violet-500/15 hover:bg-violet-500/25 animate-pulse',
                )}
              >
                {matching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                {matching ? 'matching…' : anyWired ? 'Re-match' : 'Auto-match'}
              </button>
            )}
          </div>
          <div className="absolute inset-x-0 flex justify-center pointer-events-none">
            <span className="font-mono text-xs tracking-widest text-zinc-500">
              {sidecar ? `${sidecar.scenes.length} scenes · ${sidecar.characters.length} chars` : ''}
            </span>
          </div>
          <CloseButton onClick={onClose} title="Close (ESC)" tone="emerald" />
        </div>

        <div className="flex-1 min-h-0 relative">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-emerald-400/60" />
            </div>
          ) : unsupported ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <EmptyState size="md">The graph view supports char_swap plans only.</EmptyState>
            </div>
          ) : sidecar && sidecar.scenes.length > 0 ? (
            <PlanFlowCanvas
              sidecar={sidecar}
              mediaItems={mediaItems}
              projectSlug={projectSlug ?? ''}
              sourceAspect={sourceAspect}
              actions={actions}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <EmptyState size="md">No char_swap plan to graph yet.</EmptyState>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border/50 px-6 py-3">
          <ChatInput
            assetSlugs={assetSlugs}
            commands={contextCommands}
            onSend={handleSend}
            callTool={callTool}
            projectSlug={projectSlug}
            placeholder={placeholder}
          />
        </div>
      </div>
    </>
  );
}
