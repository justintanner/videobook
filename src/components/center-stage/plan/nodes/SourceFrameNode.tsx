// A source frame extracted from the scene clip (first or last). Feeds its swap
// gen. Read-only.
import { memo } from 'react';
import { usePlanFlow } from '../PlanFlowContext';
import type { SourceFrameNodeData } from './nodeData';
import { NodeFrame } from './nodeUi';

function SourceFrameNodeImpl({ data }: { data: SourceFrameNodeData }) {
  const { projectSlug, sourceAspect } = usePlanFlow();
  const src = `/files/${projectSlug}/plan/s${data.sceneIndex + 1}-image${data.frameIndex}-source.jpg?v=${data.cacheBust}`;
  const aspectRatio = sourceAspect.css;
  return (
    <NodeFrame label={data.label} accent="border-zinc-600/60">
      <div
        className="relative w-full rounded bg-black/60 border border-zinc-800 overflow-hidden"
        style={{ aspectRatio }}
      >
        <img src={src} alt={data.label} className="w-full h-full object-cover" />
      </div>
    </NodeFrame>
  );
}

export const SourceFrameNode = memo(SourceFrameNodeImpl);
