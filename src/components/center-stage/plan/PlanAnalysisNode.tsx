// The analysis block in the char_swap flow, between the Source/Cast inputs and
// the scenes. It surfaces the prompt that drives the plan gen: the per-chunk
// user_context stacked above the analysis_prompt (the vision system prompt).
//
// Persistent + collapsible. While a plan is (re)generating it shows a spinner +
// "Generating plan…" and force-expands so the prompt is visible. Once the plan
// is ready it collapses to a labelled "Analysis prompt" header you can click to
// re-read it — so the analysis never just vanishes, but it also doesn't push the
// scenes down once you've seen it (per earlier feedback: a big always-open block
// is worse). Until the job writes those fields (the very first build) neither is
// present, so we fall back to the old "splitting…" line.
//
// The header carries the model badge (which model produced the plan), and — like
// the swap/video tiles — a JSON toggle that flips the body to the request
// "source" (model + system/user messages) that the server sends.
import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePlanFlow } from './PlanFlowContext';
import { PayloadJsonView } from '@/components/center-stage/PlanViewer';
import { FlipToggle } from './nodes/nodeUi';

function PromptBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-emerald-300/40">{label}</div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-800/60 bg-zinc-950/80 p-2.5 font-mono text-[11px] leading-relaxed text-emerald-200/80 scrollbar-hide">
        {text}
      </pre>
    </div>
  );
}

export function PlanAnalysisNode({ generating, failed, error, forceOpen, userContext, systemPrompt, model }: {
  generating: boolean;
  failed?: boolean;
  error?: string;
  // Keep the prompt expanded even when not generating — used for the draft
  // "read before you generate" gate.
  forceOpen?: boolean;
  userContext?: string;
  systemPrompt?: string;
  // The model that produces the plan (sidecar.model) — shown as a usage badge.
  model?: string;
}) {
  const { mediaItems, projectSlug } = usePlanFlow();
  const user = userContext?.trim() ?? '';
  const system = systemPrompt?.trim() ?? '';
  const errorText = error?.trim() ?? '';
  const isFailed = Boolean(failed) || errorText.length > 0;
  const hasAny = user.length > 0 || system.length > 0;
  // Collapsed by default once ready; generating / draft force-expand it.
  const [open, setOpen] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const expanded = open || generating || isFailed || Boolean(forceOpen);

  // The plan's JSON "source": the request the server sends to produce it — the
  // model plus the system/user messages — mirroring server/src/jobs/
  // plan-visualization.ts. Rendered with asset-token chips by PayloadJsonView,
  // the same component the swap/video tiles flip to.
  const payload = useMemo(
    () => ({
      model: model ?? null,
      messages: [
        ...(system.length > 0 ? [{ role: 'system', content: system }] : []),
        ...(user.length > 0 ? [{ role: 'user', content: user }] : []),
      ],
    }),
    [model, system, user],
  );

  return (
    <div className="w-full max-w-2xl rounded-md border border-emerald-500/30 bg-zinc-900/70">
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="nodrag flex flex-1 items-center gap-2 text-left"
          title={expanded ? 'Hide analysis prompt' : 'Show the analysis prompt that built this plan'}
        >
          {isFailed ? (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-300/80" />
          ) : generating ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-emerald-400/80" />
          ) : (
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-400/70" />
          )}
          <span className="font-mono text-[11px] uppercase tracking-wider text-emerald-300/70">
            {isFailed ? 'Plan failed' : generating ? 'Generating plan…' : 'Analysis prompt'}
          </span>
          {model && (
            <span className="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-emerald-300/70">
              {model}
            </span>
          )}
          {!generating && (
            <span className="ml-auto flex items-center text-zinc-500">
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </span>
          )}
        </button>
        {expanded && hasAny && <FlipToggle flipped={flipped} onToggle={() => setFlipped((f) => !f)} />}
      </div>
      {expanded && (
        <div className={cn('px-3 pb-3', !generating && 'pt-1')}>
          {isFailed ? (
            <div className="rounded border border-red-500/30 bg-red-950/20 p-2.5 font-mono text-[11px] leading-relaxed text-red-100/80">
              {errorText || 'Plan generation failed.'}
            </div>
          ) : hasAny ? (
            flipped ? (
              <PayloadJsonView payload={payload} mediaItems={mediaItems} projectSlug={projectSlug} />
            ) : (
              <div className="flex flex-col gap-2">
                {user.length > 0 && <PromptBlock label="user context" text={user} />}
                {system.length > 0 && <PromptBlock label="system prompt" text={system} />}
              </div>
            )
          ) : (
            <span className="font-mono text-[11px] text-emerald-200/70">splitting video into scenes…</span>
          )}
        </div>
      )}
    </div>
  );
}
