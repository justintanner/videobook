// A source frame extracted from the scene clip (first or last). Feeds its swap
// gen. Read-only. Source frames are extracted server-side at /plan-vis time; an
// older plan (or one mid-extraction) may not have the file on disk yet, so on a
// load error we show a calm placeholder instead of the browser's broken-image
// glyph + alt text.
import { memo, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { usePlanFlow } from '../PlanFlowContext';
import type { SourceFrameNodeData } from './nodeData';
import { NodeFrame } from './nodeUi';

function SourceFrameNodeImpl({ data }: { data: SourceFrameNodeData }) {
  const { projectSlug, sourceAspect } = usePlanFlow();
  // Track the src that failed (not a sticky bool) so a new cacheBust retries.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = `/files/${projectSlug}/plan/s${data.sceneIndex + 1}-image${data.frameIndex}-source.jpg?v=${data.cacheBust}`;
  const failed = failedSrc === src;
  const aspectRatio = sourceAspect.css;
  return (
    <NodeFrame label={data.label} accent="border-zinc-600/60">
      <div
        className="relative w-full rounded bg-black/60 border border-zinc-800 overflow-hidden flex items-center justify-center"
        style={{ aspectRatio }}
      >
        {failed ? (
          <div className="flex flex-col items-center gap-1 text-zinc-600">
            <ImageOff className="w-4 h-4" />
            <span className="text-[9px] font-mono">no source frame</span>
          </div>
        ) : (
          <img
            src={src}
            alt={data.label}
            className="w-full h-full object-cover"
            onError={() => setFailedSrc(src)}
          />
        )}
      </div>
    </NodeFrame>
  );
}

export const SourceFrameNode = memo(SourceFrameNodeImpl);
