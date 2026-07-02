// Polls the `read_plan_progress` tool for the live streaming output of an
// in-flight plan analysis, so the analysis node can render the model's work as
// it's produced. Mirrors the scene-arrival poll pattern in PlanFlowStack
// (setInterval-style loop in an effect), encapsulated as a domain hook per the
// MCP-data-layer guidance. Active only while a plan is generating.
import { useEffect, useState } from 'react';
import type { UseMcpResult } from 'use-mcp/react';

export interface PlanAnalysisProgress {
  status: 'generating' | 'done' | 'failed' | 'idle';
  text: string;
}

const EMPTY: PlanAnalysisProgress = { status: 'idle', text: '' };

const POLL_MS = 1000;

// Hard safety cap on the number of polls per active window (~6 min at 1s). The
// primary stop is `active` (=generating) going false; this ensures the hook can
// never poll unbounded even if that flag is stuck true by a future logic change.
const MAX_POLLS = 360;

async function fetchProgress(
  callTool: UseMcpResult['callTool'],
  projectSlug: string,
): Promise<PlanAnalysisProgress | null> {
  try {
    const result = await callTool('read_plan_progress', { project_slug: projectSlug });
    if (result.isError) return null;
    const raw = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { status?: string; text?: string };
    const status = (parsed.status as PlanAnalysisProgress['status']) ?? 'idle';
    return { status, text: parsed.text ?? '' };
  } catch {
    return null;
  }
}

export function usePlanAnalysisProgress({
  callTool,
  projectSlug,
  active,
}: {
  callTool: UseMcpResult['callTool'];
  projectSlug: string;
  active: boolean;
}): PlanAnalysisProgress {
  const [progress, setProgress] = useState<PlanAnalysisProgress>(EMPTY);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    const poll = async () => {
      tries += 1;
      const next = await fetchProgress(callTool, projectSlug);
      if (cancelled) return;
      if (next) setProgress(next);
      if (tries < MAX_POLLS) timer = setTimeout(() => { void poll(); }, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, callTool, projectSlug]);

  // Derive the inactive case rather than resetting state in the effect: when not
  // generating there's nothing to show, and a fresh run's first poll overwrites
  // any value left over from a prior run.
  return active ? progress : EMPTY;
}
