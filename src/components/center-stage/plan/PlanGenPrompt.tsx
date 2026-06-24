// The generation-prompt block shown in the char_swap flow between the Source/Cast
// inputs and the scenes — but ONLY while a plan is (re)generating. It surfaces the
// prompt actually driving the gen: the per-chunk user_context stacked above the
// analysis_prompt (the vision system prompt), with a spinner + "Generating plan…"
// header. When the plan is ready the caller drops this block entirely and the flow
// collapses to the plain connector. Until the job writes those fields (the very
// first build), neither is present, so we fall back to the old "splitting…" line.
import { Loader2 } from 'lucide-react';

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

export function PlanGenPrompt({ userContext, systemPrompt }: {
  userContext?: string;
  systemPrompt?: string;
}) {
  const user = userContext?.trim() ?? '';
  const system = systemPrompt?.trim() ?? '';
  const hasAny = user.length > 0 || system.length > 0;
  return (
    <div className="w-full max-w-2xl rounded-md border border-emerald-500/30 bg-zinc-900/70 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-400/80" />
        <span className="font-mono text-[11px] uppercase tracking-wider text-emerald-300/70">Generating plan…</span>
      </div>
      {hasAny ? (
        <div className="flex flex-col gap-2">
          {user.length > 0 && <PromptBlock label="user context" text={user} />}
          {system.length > 0 && <PromptBlock label="system prompt" text={system} />}
        </div>
      ) : (
        <span className="font-mono text-[11px] text-emerald-200/70">splitting video into scenes…</span>
      )}
    </div>
  );
}
