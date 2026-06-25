// Embedded, vertically-stacked char_swap editor. Replaces the full-screen React
// Flow overlay: it lives inside center stage (PlanViewer's char_swap branch), so
// the asset sidebar stays visible and characters drag straight into a frame.
//
// A pure projection of the plan sidecar — the source video + cast sit at the top
// (PlanInputsNode, editable), then each scene renders top→bottom as source frames
// → swap frames → video. Owns the shared actions hook, the clip/audio bootstrap,
// the scene-arrival poll, and the regenerate-from-new-inputs poll.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import type { UseMcpResult } from 'use-mcp/react';
import { toast } from '@/hooks/useToast';
import type { MediaItem } from '@/components/sidebar/types';
import type { SourceAspect } from '@/lib/plan-aspect';
import { PlanFlowProvider, type PlanFlowContextValue } from './PlanFlowContext';
import { PlanAnalysisNode } from './PlanAnalysisNode';
import { FlowColumn, FlowStep } from './flow/FlowColumn';
import { FlowConnector } from './flow/FlowConnector';
import { BendableConnector } from './flow/BendableConnector';
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
    const parsed = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text) as PlanSidecar & {
      exists?: boolean;
      formula?: string;
    };
    return parsed.exists === false ? null : parsed;
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

  // Persisted bend geometry for a flow connector (straight when unset). Commit
  // wiring lives in `actions.setConnectorGeometry` (writes sidecar.connectors).
  const bendFor = useCallback(
    (id: string) => sidecar.connectors?.[id] ?? { dx: 0, dy: 0 },
    [sidecar.connectors],
  );

  const building = sidecar.scenes.length === 0;
  const failed = building && sidecar.generation_status === 'failed';

  // --- Regenerate from new inputs: re-run plan_visualization, then poll
  // read_plan until the rebuilt plan (new source/cast + fresh scenes) lands.
  // plan_visualization overwrites .plan.json once at job completion, so the
  // signature flips atomically — no partial-plan window to guard.
  const [regenerating, setRegenerating] = useState(false);
  // `starting` bridges the explicit Generate click → the first read_plan that
  // shows the job underway (so the loader/poll take over before the sidecar's
  // awaiting_start flag clears).
  const [starting, setStarting] = useState(false);
  // Draft: prepared (skeleton written) but the vision job hasn't been enqueued —
  // the user reads the prompt and clicks Generate. We don't poll while in draft.
  // A regenerate-from-new-inputs is an explicit immediate gen, so it leaves draft.
  const draft = building && Boolean(sidecar.awaiting_start) && !failed && !starting && !regenerating;
  // `generating` drives the analysis block's loader/force-expand: a started first
  // build (no scenes yet, not draft) or an in-flight regenerate from new inputs.
  const generating = !failed && ((building && !draft) || regenerating);
  // The analysis block stays in the flow whenever there's a prompt to show (or a
  // gen/draft is in play), so the analysis prompt is discoverable in a finished
  // plan — not only while generating.
  const showAnalysis =
    failed || generating || draft || Boolean(sidecar.analysis_prompt?.trim()) || Boolean(sidecar.user_context?.trim());
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
        planInputsSignature(parsed) === target
      ) {
        if (parsed.generation_status === 'failed') {
          onSidecarUpdate(parsed);
          toast({ title: 'Plan failed', description: parsed.generation_error ?? 'plan generation failed', duration: 5000 });
          setRegenerating(false);
          return;
        }
        if (parsed.scenes.length > 0) {
          onSidecarUpdate(parsed);
          setRegenerating(false);
          return;
        }
      }
      if (tries >= MAX_TRIES) {
        setRegenerating(false);
        return;
      }
      regenPollRef.current = setTimeout(() => { void poll(); }, 3000);
    };
    regenPollRef.current = setTimeout(() => { void poll(); }, 3000);
  }, [regenerating, callTool, projectSlug, onSidecarUpdate]);

  // --- Generate (leave draft): the user reviewed the prompt and clicked Generate.
  // Enqueue the vision job (a non-deferred plan_visualization for the same inputs)
  // and clear the draft marker locally so the loader + scene poll take over.
  const runGenerate = useCallback(async () => {
    if (starting) return;
    const source = sidecar.source_asset_id;
    const a = sidecar.characters[0]?.asset_id;
    const b = sidecar.characters[1]?.asset_id;
    if (!source || !a || !b) return;
    setStarting(true);
    const result = await callTool('plan_visualization', {
      source_asset_id: source,
      project_slug: projectSlug,
      character_asset_ids: [a, b],
    });
    if (result.isError) {
      const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'plan_visualization failed';
      toast({ title: 'Generate failed', description: msg, duration: 5000 });
      setStarting(false);
      return;
    }
    onSidecarUpdate({
      ...sidecar,
      awaiting_start: false,
      generation_status: 'generating',
      generation_error: undefined,
      failed_at: undefined,
    });
    setStarting(false);
  }, [starting, sidecar, callTool, projectSlug, onSidecarUpdate]);

  // --- Scene-arrival poll: once generation has started, scenes may not exist
  // yet. Poll read_plan until they do (~5 min budget), then stop. Skipped while
  // in draft (no job running). setState lives in the async closure so the effect
  // body stays setState-free (react-hooks lint).
  useEffect(() => {
    if (sidecar.scenes.length > 0 || draft || failed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    const MAX_TRIES = 100; // ~5 min at 3s
    const attempt = async () => {
      tries += 1;
      const parsed = parsePlan(await callTool('read_plan', { project_slug: projectSlug }));
      if (cancelled) return;
      if (parsed && (!parsed.formula || parsed.formula === 'char_swap')) {
        if (parsed.generation_status === 'failed') {
          onSidecarUpdate(parsed);
          return;
        }
        if (parsed.scenes.length > 0) {
          onSidecarUpdate(parsed);
          return;
        }
      }
      if (tries < MAX_TRIES) timer = setTimeout(() => { void attempt(); }, 3000);
    };
    timer = setTimeout(() => { void attempt(); }, 3000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sidecar.scenes.length, draft, failed, callTool, projectSlug, onSidecarUpdate]);

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

        {/* Analysis prompt — persistent + collapsible. Force-expands while
            (re)generating or in draft (read before you generate), then stays as a
            collapsed "Analysis prompt" header in the finished plan so it's still
            discoverable (not gone after gen). */}
        {showAnalysis && <FlowConnector height={40} />}
        {showAnalysis && (
          <FlowStep>
            <PlanAnalysisNode
              generating={generating}
              failed={failed}
              error={sidecar.generation_error}
              forceOpen={draft}
              userContext={sidecar.user_context}
              systemPrompt={sidecar.analysis_prompt}
              model={sidecar.model}
            />
          </FlowStep>
        )}

        {/* Draft → an explicit Generate gate: nothing runs until the user, having
            read the prompt above, starts the job. */}
        {draft && <FlowConnector height={40} />}
        {draft && (
          <FlowStep>
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => { void runGenerate(); }}
                disabled={starting}
                className="flex items-center gap-2 rounded-md border border-emerald-500/60 bg-emerald-500/15 px-5 py-2.5 font-mono text-sm font-bold uppercase tracking-wider text-emerald-100 transition-colors hover:bg-emerald-500/25 disabled:opacity-50"
              >
                {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {starting ? 'Starting…' : 'Generate plan'}
              </button>
              <span className="font-mono text-[10px] text-zinc-500">
                reads the source, splits it into scenes, and writes a prompt per scene
              </span>
            </div>
          </FlowStep>
        )}

        {sidecar.scenes.length > 0 && <FlowConnector height={40} />}

        {sidecar.scenes.map((scene, s) => {
          const cacheBust = `${scene.start.toFixed(2)}-${scene.end.toFixed(2)}`;
          return (
            <Fragment key={s}>
              {/* between scenes — bendable connector (scenes come from video splitting) */}
              {s > 0 && (
                <BendableConnector
                  bend={bendFor(`s${s}-gap`)}
                  onCommit={(dx, dy) => { void actions.setConnectorGeometry(`s${s}-gap`, dx, dy); }}
                />
              )}
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
                <BendableConnector
                  bend={bendFor(`s${s}-source-swap`)}
                  onCommit={(dx, dy) => { void actions.setConnectorGeometry(`s${s}-source-swap`, dx, dy); }}
                />
                <FlowStep>
                  <div className="flex flex-wrap justify-center gap-3">
                    <SwapGenNode data={{ sceneIndex: s, frameIndex: 1, label: `S${s + 1} · swap frame 1` }} />
                    <SwapGenNode data={{ sceneIndex: s, frameIndex: 2, label: `S${s + 1} · swap frame 2` }} />
                  </div>
                </FlowStep>
                <BendableConnector
                  bend={bendFor(`s${s}-swap-video`)}
                  onCommit={(dx, dy) => { void actions.setConnectorGeometry(`s${s}-swap-video`, dx, dy); }}
                />
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
