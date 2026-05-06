import { RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RewriteMeta } from '@/hooks/useAssetHistory';

interface LastRewriteChipProps {
  meta: RewriteMeta;
  onClick?: (meta: RewriteMeta) => void;
}

export function LastRewriteChip({ meta, onClick }: LastRewriteChipProps) {
  const parts = [meta.model, meta.variant];
  if (meta.platform) parts.push(meta.platform);
  const promptPreview = meta.customPrompt?.trim();

  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={() => onClick?.(meta)}
      title={promptPreview
        ? `Last rewrite: ${parts.join(' · ')}\n\n"${promptPreview}"\n\nClick to reuse.`
        : `Last rewrite: ${parts.join(' · ')}. Click to reuse.`}
      className={cn(
        'shrink-0 w-full flex items-center gap-1.5 px-3 py-1',
        'text-[11px] font-mono',
        'text-emerald-300/90 hover:text-emerald-200',
        'bg-emerald-500/5 hover:bg-emerald-500/10 border-b border-emerald-500/20',
        'transition-colors duration-150',
        'overflow-hidden',
      )}
    >
      <RotateCw className="w-3 h-3 shrink-0 text-emerald-400/80" />
      <span className="font-bold uppercase tracking-wider shrink-0">
        {parts.join(' · ')}
      </span>
      {promptPreview && (
        <>
          <span className="text-emerald-500/40 shrink-0">·</span>
          <span className="truncate text-emerald-100/80 italic">
            &ldquo;{promptPreview}&rdquo;
          </span>
        </>
      )}
    </button>
  );
}
