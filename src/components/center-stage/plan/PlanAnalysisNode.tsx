// The analysis block in the char_swap flow, between the Source/Cast inputs and
// the scenes. It surfaces EXACTLY what gets sent to the vision model so the
// request is never a black box — answering "where are the images?".
//
// What the planner actually receives (mirrors server/src/jobs/plan-visualization.ts):
//   • the system instructions (analysis_prompt)
//   • a text description per character — the character REFERENCE IMAGES are NOT
//     sent; their likeness is applied later, in the per-frame swap step
//   • the source video's sampled frames — these are the ONLY images in the call
//   • the transcript + chunk timestamps (baked into user_context)
// The body shows each of these with its source labelled; the JSON flip mirrors
// the real Gemini `contents/parts` request (frames included as image parts).
//
// Persistent + collapsible. While a plan is (re)generating it shows a spinner +
// "Generating plan…" and force-expands. Once ready it collapses to a labelled
// "Analysis prompt" header you can click to re-read.
import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Image as ImageIcon, Loader2, Sparkles, Type } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePlanFlow } from './PlanFlowContext';
import { PayloadJsonView } from '@/components/center-stage/PlanViewer';
import { FlipToggle } from './nodes/nodeUi';

function AssetChip({ id }: { id: string }) {
  return (
    <span className="rounded border border-cyan-500/30 bg-cyan-500/10 px-1 py-0.5 font-mono text-[9px] tracking-wide text-cyan-300/80">
      @{id.replace(/^@/, '')}
    </span>
  );
}

// One labelled input row: where it came from (header) + how it's sent (text vs
// image badge) + the actual content.
function SourceBlock({
  label,
  asset,
  kind,
  note,
  text,
}: {
  label: string;
  asset?: string;
  kind: 'text' | 'image';
  note?: string;
  text?: string;
}) {
  return (
    <div className="rounded border border-zinc-800/60 bg-zinc-950/60 p-2">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[9px] uppercase tracking-wider text-emerald-300/50">{label}</span>
        {asset && <AssetChip id={asset} />}
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider',
            kind === 'image'
              ? 'bg-amber-500/10 text-amber-300/80'
              : 'bg-sky-500/10 text-sky-300/80',
          )}
        >
          {kind === 'image' ? <ImageIcon className="h-2.5 w-2.5" /> : <Type className="h-2.5 w-2.5" />}
          {kind === 'image' ? 'sent as image' : 'sent as text'}
        </span>
      </div>
      {note && <div className="font-mono text-[10px] leading-relaxed text-zinc-400">{note}</div>}
      {text && text.length > 0 && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-emerald-200/80 scrollbar-hide">
          {text}
        </pre>
      )}
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
  const { sidecar, mediaItems, projectSlug } = usePlanFlow();
  const user = userContext?.trim() ?? '';
  const system = systemPrompt?.trim() ?? '';
  const errorText = error?.trim() ?? '';
  const isFailed = Boolean(failed) || errorText.length > 0;
  // Collapsed by default once ready; generating / draft force-expand it.
  const [open, setOpen] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const expanded = open || generating || isFailed || Boolean(forceOpen);

  const characters = sidecar.characters ?? [];
  // The sampled frames the server attaches as image parts — the ONLY images in
  // the request. Empty until the vision job runs (draft state).
  const frames = useMemo(() => sidecar.scenes.flatMap((s) => s.frames ?? []), [sidecar.scenes]);
  const frameCount = frames.length;
  const wordCount = sidecar.word_count ?? 0;
  const videoNote =
    frameCount > 0
      ? `${frameCount} sampled frame${frameCount === 1 ? '' : 's'} + transcript${wordCount > 0 ? ` (${wordCount} words)` : ''} + chunk timestamps`
      : 'sampled frames (images) + transcript + chunk timestamps — computed when you generate';

  // The plan's JSON "source": the real request the server sends, mirroring
  // server/src/jobs/plan-visualization.ts — a single user turn whose `parts`
  // are the instructions text, the cast+video context text, then one image part
  // per sampled frame. Frame bytes are shown as a placeholder, not raw base64.
  const payload = useMemo(() => {
    const parts: Array<Record<string, unknown>> = [];
    if (system.length > 0) parts.push({ text: `Instructions:\n${system}` });
    if (user.length > 0) parts.push({ text: user });
    for (const f of frames) {
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: `«frame ${f.name} @${f.t.toFixed(2)}s»` } });
    }
    return { model: model ?? null, contents: [{ role: 'user', parts }] };
  }, [model, system, user, frames]);

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
        {expanded && !isFailed && <FlipToggle flipped={flipped} onToggle={() => setFlipped((f) => !f)} />}
      </div>
      {expanded && (
        <div className={cn('px-3 pb-3', !generating && 'pt-1')}>
          {isFailed ? (
            <div className="rounded border border-red-500/30 bg-red-950/20 p-2.5 font-mono text-[11px] leading-relaxed text-red-100/80">
              {errorText || 'Plan generation failed.'}
            </div>
          ) : flipped ? (
            <PayloadJsonView payload={payload} mediaItems={mediaItems} projectSlug={projectSlug} />
          ) : (
            <div className="flex flex-col gap-2">
              {/* Provenance: what each input becomes in the request. */}
              <div className="rounded border border-amber-500/20 bg-amber-500/[0.04] p-2 font-mono text-[10px] leading-relaxed text-amber-200/70">
                The only images sent to the model are the video&apos;s sampled frames. Each character is
                sent as a <span className="text-sky-300/80">text description</span> read from its
                reference image — the likeness itself is applied later, in the per-frame swap.
              </div>

              {characters.map((c, i) => (
                <SourceBlock
                  key={c.asset_id}
                  label={`character ${String.fromCharCode(65 + i)}${c.name ? ` · ${c.name}` : ''}`}
                  asset={c.asset_id}
                  kind="text"
                  text={c.description?.trim() || '(no description yet)'}
                />
              ))}

              <SourceBlock
                label="video source"
                asset={sidecar.source_asset_id}
                kind="image"
                note={videoNote}
              />

              {system.length > 0 && (
                <SourceBlock label="instructions (system)" kind="text" text={system} />
              )}

              {user.length > 0 ? (
                <SourceBlock label="cast + video context (full user message)" kind="text" text={user} />
              ) : (
                <span className="font-mono text-[11px] text-emerald-200/70">
                  The per-chunk video context (frames, dialogue, timestamps) is assembled when you generate the plan.
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
