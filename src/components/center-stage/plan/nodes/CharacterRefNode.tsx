// Left-rail character reference. Shared across every scene's swaps — feeds the
// char_swap image gens. Read-only (source handle only).
import { memo } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import { UserRound } from 'lucide-react';
import { usePlanFlow } from '../PlanFlowContext';
import type { CharacterRefNodeData } from '../buildPlanGraph';
import { NodeFrame } from './nodeUi';

function CharacterRefNodeImpl({ data }: NodeProps<Node<CharacterRefNodeData>>) {
  const { mediaItems } = usePlanFlow();
  const item = mediaItems.find((m) => m.id === data.assetId);
  const thumb = item?.thumbnailSrc ?? item?.filePath ?? null;
  return (
    <NodeFrame label={data.name || data.assetId} accent="border-violet-600/50" target={false} width={170}>
      <div className="relative w-full rounded bg-black/60 border border-zinc-800 overflow-hidden flex items-center justify-center aspect-square">
        {thumb ? (
          <img src={thumb} alt={data.name} className="w-full h-full object-cover" />
        ) : (
          <UserRound className="w-5 h-5 text-zinc-600" />
        )}
      </div>
      <div className="mt-1 text-[9px] font-mono text-violet-300/50 truncate">@{data.assetId}</div>
    </NodeFrame>
  );
}

export const CharacterRefNode = memo(CharacterRefNodeImpl);
