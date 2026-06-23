// Embedded, vertically-stacked char_swap editor. Replaces the full-screen React
// Flow overlay: it lives inside center stage (PlanViewer's char_swap branch), so
// the asset sidebar stays visible and characters drag straight into a frame.
//
// A pure projection of the plan sidecar — each scene renders top→bottom as
// source frames → swap frames → video. Owns the shared actions hook, the
// clip/audio bootstrap, the vision Auto-match button, and the scene-arrival poll
// (the latter two re-homed from the old PlanFlowEditor).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UseMcpResult } from 'use-mcp/react';
import type { MediaItem } from '@/components/sidebar/types';
import type { SourceAspect } from '@/lib/plan-aspect';
import { PlanFlowProvider, type PlanFlowContextValue } from './PlanFlowContext';
import { useCharSwapActions } from './useCharSwapActions';
import { useSceneFilesBootstrap } from './useSceneFilesBootstrap';
import { formatTimecode, type PlanSidecar } from './charSwapModel';
import { SourceFrameNode } from './nodes/SourceFrameNode';
import { SwapGenNode } from './nodes/SwapGenNode';
import { SceneVideoNode } from './nodes/SceneVideoNode';

interface PlanFlowStackProps {
  sidecar: PlanSidecar;
  mediaItems: MediaItem[];
  projectSlug: string;
  sourceAspect: SourceAspect;
  callTool: UseMcpResult['callTool'];
  onSidecarUpdate: (sidecar: PlanSidecar) => void;
}

// Fingerprint of the per-frame wiring across all scenes — detects when a
// background auto-match job has written new frame_characters.
function frameCharsSignature(sc: PlanSidecar): string {
  return sc.scenes.map((s) => JSON.stringify(s.frame_characters ?? null)).join('|');
}
function planHasWiring(sc: PlanSidecar): boolean {
  return sc.scenes.some(
    (s) => (s.frame_characters?.image1?.length ?? 0) > 0 || (s.frame_characters?.image2?.length ?? 0) > 0,
  );
}

function parsePlan(result: Awaited<ReturnType<UseMcpResult['callTool']>>): (PlanSidecar & { formula?: string }) | null {
  if (result.isError) return null;
  try {
    return JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text) as PlanSidecar & {
      formula?: string;
    };
  } catch {
    return null;
  }
}

export function PlanFlowStack({
  sidecar,
  mediaItems,
  projectSlug,
  sourceAspect,
  callTool,
  onSidecarUpdate,
}: PlanFlowStackProps) {
  const actions = useCharSwapActions({ sidecar, mediaItems, projectSlug, sourceAspect, callTool, onSidecarUpdate });
  // Extract per-scene clips/audio so video gens have their references (no-ops
  // until scenes exist; module-deduped against the source asset).
  useSceneFilesBootstrap({ sidecar, projectSlug, callTool });

  const ctx = useMemo<PlanFlowContextValue>(
    () => ({ sidecar, characters: sidecar.characters, mediaItems, projectSlug, sourceAspect, actions }),
    [sidecar, mediaItems, projectSlug, sourceAspect, actions],
  );

  const anyWired = useMemo(() => planHasWiring(sidecar), [sidecar]);
  const building = sidecar.scenes.length === 0;

  // --- Vision auto-match: enqueue + poll until the wiring changes -----------
  const [matching, setMatching] = useState(false);
  const matchPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      if (matchPollRef.current) {
        clearTimeout(matchPollRef.current);
        matchPollRef.current = null;
      }
    };
  }, []);

  const runAutoMatch = useCallback(async () => {
    if (matching) return;
    const before = frameCharsSignature(sidecar);
    setMatching(true);
    const enqueued = await actions.matchCharacters();
    if (!enqueued) {
      setMatching(false);
      return;
    }
    let tries = 0;
    const poll = async () => {
      tries += 1;
      const parsed = parsePlan(await callTool('read_plan', { project_slug: projectSlug }));
      if (cancelledRef.current) {
        setMatching(false);
        return;
      }
      if (parsed && (!parsed.formula || parsed.formula === 'char_swap') && frameCharsSignature(parsed) !== before) {
        onSidecarUpdate(parsed);
        setMatching(false);
        return;
      }
      if (tries >= 24) {
        setMatching(false);
        return;
      }
      matchPollRef.current = setTimeout(() => { void poll(); }, 3000);
    };
    matchPollRef.current = setTimeout(() => { void poll(); }, 3000);
  }, [matching, sidecar, actions, callTool, projectSlug, onSidecarUpdate]);

  // --- Scene-arrival poll: the template flow lands here the moment
  // plan_visualization is enqueued, so scenes may not exist yet. Poll read_plan
  // until they do (~5 min budget), then stop. setState lives in the async
  // closure so the effect body stays setState-free (react-hooks lint).
  useEffect(() => {
    if (sidecar.scenes.length > 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    const MAX_TRIES = 100; // ~5 min at 3s
    const attempt = async () => {
      tries += 1;
      const parsed = parsePlan(await callTool('read_plan', { project_slug: projectSlug }));
      if (cancelled) return;
      if (parsed && (!parsed.formula || parsed.formula === 'char_swap') && parsed.scenes.length > 0) {
        onSidecarUpdate(parsed);
        return;
      }
      if (tries < MAX_TRIES) timer = setTimeout(() => { void attempt(); }, 3000);
    };
    timer = setTimeout(() => { void attempt(); }, 3000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sidecar.scenes.length, callTool, projectSlug, onSidecarUpdate]);

  return (
    <PlanFlowProvider value={ctx}>
      <div className="flex flex-col gap-5" data-plan-stack>
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-zinc-950/85 backdrop-blur-sm py-2">
          <span className="font-mono text-[11px] tracking-widest text-zinc-500">
            {sidecar.scenes.length} scenes · {sidecar.characters.length} chars
          </span>
          {sidecar.scenes.length > 0 && (
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

        {building && (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-zinc-900/70 px-3 py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400/80" />
            <span className="font-mono text-[11px] text-emerald-200/80">splitting video into scenes…</span>
          </div>
        )}

        {sidecar.scenes.map((scene, s) => {
          const cacheBust = `${scene.start.toFixed(2)}-${scene.end.toFixed(2)}`;
          return (
            <section
              key={s}
              className="flex flex-col gap-3 border-t border-zinc-800/60 pt-4 first:border-t-0 first:pt-0"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs font-bold tracking-wider text-emerald-300/80 uppercase">
                  Scene {s + 1}
                </span>
                <span className="font-mono text-[10px] text-zinc-600">
                  {formatTimecode(scene.start)}–{formatTimecode(scene.end)}
                </span>
              </div>
              <div className="flex flex-wrap gap-3">
                <SourceFrameNode data={{ sceneIndex: s, frameIndex: 1, cacheBust, label: `S${s + 1} · source first` }} />
                <SourceFrameNode data={{ sceneIndex: s, frameIndex: 2, cacheBust, label: `S${s + 1} · source last` }} />
              </div>
              <div className="flex flex-wrap gap-3">
                <SwapGenNode data={{ sceneIndex: s, frameIndex: 1, label: `S${s + 1} · swap frame 1` }} />
                <SwapGenNode data={{ sceneIndex: s, frameIndex: 2, label: `S${s + 1} · swap frame 2` }} />
              </div>
              <SceneVideoNode data={{ sceneIndex: s, label: `S${s + 1} · video` }} />
            </section>
          );
        })}
      </div>
    </PlanFlowProvider>
  );
}
