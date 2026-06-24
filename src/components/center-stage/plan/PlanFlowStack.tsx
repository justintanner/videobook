// Embedded, vertically-stacked char_swap editor. Replaces the full-screen React
// Flow overlay: it lives inside center stage (PlanViewer's char_swap branch), so
// the asset sidebar stays visible and characters drag straight into a frame.
//
// A pure projection of the plan sidecar — the source video + cast sit at the top
// (PlanInputsNode, editable), then each scene renders top→bottom as source frames
// → swap frames → video. Owns the shared actions hook, the clip/audio bootstrap,
// the scene-arrival poll, and the regenerate-from-new-inputs poll.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { UseMcpResult } from 'use-mcp/react';
import { toast } from '@/hooks/useToast';
import type { MediaItem } from '@/components/sidebar/types';
import type { SourceAspect } from '@/lib/plan-aspect';
import { PlanFlowProvider, type PlanFlowContextValue } from './PlanFlowContext';
import { FlowColumn, FlowStep } from './flow/FlowColumn';
import { FlowConnector } from './flow/FlowConnector';
import { useCharSwapActions } from './useCharSwapActions';
import { useSceneFilesBootstrap } from './useSceneFilesBootstrap';
import { formatTimecode, type PlanSidecar } from './charSwapModel';
import { SourceFrameNode } from './nodes/SourceFrameNode';
import { SwapGenNode } from './nodes/SwapGenNode';
import { SceneVideoNode } from './nodes/SceneVideoNode';
import { PlanInputsNode, type PlanInputs } from './nodes/PlanInputsNode';

interface PlanFlowStackProps {
  sidecar: PlanSidecar;
  mediaItems: MediaItem[];
  projectSlug: string;
  sourceAspect: SourceAspect;
  callTool: UseMcpResult['callTool'];
  onSidecarUpdate: (sidecar: PlanSidecar) => void;
}

// Source + cast fingerprint. Used to detect when a regenerate's new plan has
// landed, and to key PlanInputsNode so it re-seeds from the committed inputs.
function planInputsSignature(sc: PlanSidecar): string {
  return `${sc.source_asset_id}|${sc.characters.map((c) => c.asset_id).join(',')}`;
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

  const building = sidecar.scenes.length === 0;

  // --- Regenerate from new inputs: re-run plan_visualization, then poll
  // read_plan until the rebuilt plan (new source/cast + fresh scenes) lands.
  // plan_visualization overwrites .plan.json once at job completion, so the
  // signature flips atomically — no partial-plan window to guard.
  const [regenerating, setRegenerating] = useState(false);
  const regenPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      if (regenPollRef.current) {
        clearTimeout(regenPollRef.current);
        regenPollRef.current = null;
      }
    };
  }, []);

  const runRegenerate = useCallback(async (next: PlanInputs) => {
    if (regenerating) return;
    const target = `${next.sourceId}|${next.charAId},${next.charBId}`;
    setRegenerating(true);
    const result = await callTool('plan_visualization', {
      source_asset_id: next.sourceId,
      project_slug: projectSlug,
      character_asset_ids: [next.charAId, next.charBId],
    });
    if (result.isError) {
      const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'plan_visualization failed';
      toast({ title: 'Regenerate failed', description: msg, duration: 5000 });
      setRegenerating(false);
      return;
    }
    let tries = 0;
    const MAX_TRIES = 100; // ~5 min at 3s — vision + ffmpeg re-split
    const poll = async () => {
      tries += 1;
      const parsed = parsePlan(await callTool('read_plan', { project_slug: projectSlug }));
      if (cancelledRef.current) {
        setRegenerating(false);
        return;
      }
      if (
        parsed &&
        (!parsed.formula || parsed.formula === 'char_swap') &&
        planInputsSignature(parsed) === target &&
        parsed.scenes.length > 0
      ) {
        onSidecarUpdate(parsed);
        setRegenerating(false);
        return;
      }
      if (tries >= MAX_TRIES) {
        setRegenerating(false);
        return;
      }
      regenPollRef.current = setTimeout(() => { void poll(); }, 3000);
    };
    regenPollRef.current = setTimeout(() => { void poll(); }, 3000);
  }, [regenerating, callTool, projectSlug, onSidecarUpdate]);

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
      <FlowColumn className="max-w-3xl">
        <FlowStep>
          <PlanInputsNode
            key={planInputsSignature(sidecar)}
            sourceId={sidecar.source_asset_id ?? null}
            charAId={sidecar.characters[0]?.asset_id ?? null}
            charBId={sidecar.characters[1]?.asset_id ?? null}
            mediaItems={mediaItems}
            sourceAspect={sourceAspect}
            regenerating={regenerating}
            onRegenerate={(next) => { void runRegenerate(next); }}
          />
        </FlowStep>

        {building && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-500/40 bg-zinc-900/70 px-3 py-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400/80" />
            <span className="font-mono text-[11px] text-emerald-200/80">splitting video into scenes…</span>
          </div>
        )}

        {sidecar.scenes.length > 0 && <FlowConnector height={40} />}

        {sidecar.scenes.map((scene, s) => {
          const cacheBust = `${scene.start.toFixed(2)}-${scene.end.toFixed(2)}`;
          return (
            <Fragment key={s}>
              {/* between scenes — passive connector (scenes come from video splitting) */}
              {s > 0 && <FlowConnector height={40} />}
              <div className="flex w-full flex-col items-center">
                <div className="mb-2 flex items-baseline gap-2">
                  <span className="font-mono text-xs font-bold tracking-wider text-emerald-300/80 uppercase">
                    Scene {s + 1}
                  </span>
                  <span className="font-mono text-[10px] text-zinc-600">
                    {formatTimecode(scene.start)}–{formatTimecode(scene.end)}
                  </span>
                </div>
                <FlowStep>
                  <div className="flex flex-wrap justify-center gap-3">
                    <SourceFrameNode data={{ sceneIndex: s, frameIndex: 1, cacheBust, label: `S${s + 1} · source first` }} />
                    <SourceFrameNode data={{ sceneIndex: s, frameIndex: 2, cacheBust, label: `S${s + 1} · source last` }} />
                  </div>
                </FlowStep>
                <FlowConnector />
                <FlowStep>
                  <div className="flex flex-wrap justify-center gap-3">
                    <SwapGenNode data={{ sceneIndex: s, frameIndex: 1, label: `S${s + 1} · swap frame 1` }} />
                    <SwapGenNode data={{ sceneIndex: s, frameIndex: 2, label: `S${s + 1} · swap frame 2` }} />
                  </div>
                </FlowStep>
                <FlowConnector />
                <FlowStep>
                  <SceneVideoNode data={{ sceneIndex: s, label: `S${s + 1} · video` }} />
                </FlowStep>
              </div>
            </Fragment>
          );
        })}
      </FlowColumn>
    </PlanFlowProvider>
  );
}
