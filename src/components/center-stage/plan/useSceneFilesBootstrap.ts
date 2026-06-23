// Extracts the per-scene source clips (sN.mp4) and audio (sN.mp3) a char_swap
// plan needs before any video gen can run. The plan sidecar carries the target
// `clip_filename` / `audio_filename` (stamped by /plan-vis), but the files
// themselves are written client-side by an even_split + extract_audio bootstrap.
//
// This used to live inline in PlanViewer's PlanScenes (the scene list). It now
// lives here so the graph (PlanFlowEditor) can run it too — the template flow
// opens the graph directly and never mounts the scene list. A module-level
// in-flight map keyed by (project, source) dedupes the work when both surfaces
// are mounted for the same plan, so even_split fires exactly once.
import { useEffect, useRef, useState } from 'react';
import type { UseMcpResult } from 'use-mcp/react';
import { toast } from '@/hooks/useToast';
import { PLAN_ASSET_ID, type PlanSidecar } from './charSwapModel';

type CallTool = UseMcpResult['callTool'];

function readErr(result: Awaited<ReturnType<CallTool>>, fallback: string): string {
  return (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? fallback;
}

function manifestNames(result: Awaited<ReturnType<CallTool>>): Set<string> {
  try {
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { files?: Array<{ name: string }> };
    return new Set((parsed.files ?? []).map((f) => f.name));
  } catch {
    return new Set();
  }
}

// Two phases: (1) read the plan asset's manifest; if any sN.mp4 is missing, fire
// one even_split (destination mode writes every chunk into plan/ in one commit).
// (2) for each missing sN.mp3, fire extract_audio windowed to that scene so the
// mp3 stays under seedance-2's reference cap. Both tools enqueueAndWait, so the
// files exist on disk by the time this resolves. Returns whether all are ready.
async function bootstrapSceneFiles(projectSlug: string, sidecar: PlanSidecar, callTool: CallTool): Promise<boolean> {
  const scenes = sidecar.scenes;
  const sceneCount = scenes.length;

  const manifestResult = await callTool('asset_manifest', { project_slug: projectSlug, asset_id: PLAN_ASSET_ID });
  let presentNames = manifestResult.isError ? new Set<string>() : manifestNames(manifestResult);

  const missingClips = scenes
    .map((s, i) => ({ scene: s, index: i }))
    .filter(({ scene }) => scene.clip_filename && !presentNames.has(scene.clip_filename));

  if (missingClips.length > 0) {
    // Destination mode rejects overwrites, so a partial clip set needs a manual
    // fix or a /plan-vis re-run — only fire when the whole set is missing.
    if (missingClips.length !== sceneCount) {
      toast({
        title: 'Plan clips partially present',
        description: `${sceneCount - missingClips.length}/${sceneCount} clips already on disk. Delete the partial set or re-run /plan-vis.`,
        duration: 6000,
      });
    } else {
      const splitResult = await callTool('even_split', {
        project_slug: projectSlug,
        asset_id: sidecar.source_asset_id,
        target_secs: scenes.map((s) => s.end - s.start),
        destination: {
          asset_id: PLAN_ASSET_ID,
          filenames: scenes.map((s) => s.clip_filename!),
        },
      });
      if (splitResult.isError) {
        toast({ title: 'Source clip split failed', description: readErr(splitResult, 'even_split failed'), duration: 5000 });
        return false;
      }
      // Re-read the manifest so the audio phase sees the freshly-written clips.
      const refreshed = await callTool('asset_manifest', { project_slug: projectSlug, asset_id: PLAN_ASSET_ID });
      if (!refreshed.isError) presentNames = manifestNames(refreshed);
    }
  }

  let allAudioOk = true;
  for (const scene of scenes) {
    if (!scene.audio_filename) { allAudioOk = false; continue; }
    if (presentNames.has(scene.audio_filename)) continue;
    const audResult = await callTool('extract_audio', {
      project_slug: projectSlug,
      asset_id: sidecar.source_asset_id,
      destination: { asset_id: PLAN_ASSET_ID, filename: scene.audio_filename },
      // Window to this scene so the mp3 stays under seedance-2's 15.2s cap.
      range: { start_s: scene.start, duration_s: scene.end - scene.start },
    });
    if (audResult.isError) {
      allAudioOk = false;
      toast({ title: `Audio extract failed for ${scene.audio_filename}`, description: readErr(audResult, 'extract_audio failed'), duration: 5000 });
    }
  }

  const allClipsOk = scenes.every((s) => s.clip_filename);
  return allClipsOk && allAudioOk;
}

// Cross-instance dedup: the scene list and the graph can both mount for the same
// char_swap plan. Keyed by `${projectSlug}/${sourceAssetId}`.
const inFlight = new Map<string, Promise<boolean>>();

export function useSceneFilesBootstrap(params: {
  projectSlug: string;
  sidecar: PlanSidecar;
  callTool: CallTool;
}): boolean {
  const { projectSlug, sidecar, callTool } = params;
  const [ready, setReady] = useState(false);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    const sceneCount = sidecar.scenes.length;
    // Old plans (pre destination-mode plan-vis) have no per-scene filenames; the
    // render path prompts a re-run instead, so don't bootstrap them here.
    const needsRegen = sceneCount > 0 && (!sidecar.scenes[0].clip_filename || !sidecar.scenes[0].audio_filename);
    if (sceneCount === 0 || needsRegen) return;

    const key = `${projectSlug}/${sidecar.source_asset_id}`;
    if (keyRef.current === key) return;
    keyRef.current = key;

    let cancelled = false;
    void (async () => {
      // Reset readiness inside the async closure so the synchronous effect body
      // stays setState-free (react-hooks/set-state-in-effect).
      setReady(false);
      let p = inFlight.get(key);
      if (!p) {
        p = bootstrapSceneFiles(projectSlug, sidecar, callTool);
        inFlight.set(key, p);
        // Clear once settled so a later mount can cheaply re-verify (a manifest
        // read that no-ops when the files already exist).
        void p.finally(() => { if (inFlight.get(key) === p) inFlight.delete(key); });
      }
      const ok = await p;
      if (!cancelled) setReady(ok);
    })();
    return () => { cancelled = true; };
  }, [projectSlug, sidecar, callTool]);

  return ready;
}
