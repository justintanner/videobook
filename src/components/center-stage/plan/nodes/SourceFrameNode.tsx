// A source frame extracted from the scene clip (first or last). Feeds its swap
// gen. Read-only. Source frames are extracted server-side at /plan-vis time. The
// sidecar can report a scene a beat before the server finishes writing the JPEG,
// so the first request may 404; we retry a few times before falling back to a
// calm placeholder (instead of the browser's broken-image glyph), so the frame
// self-heals the instant the file lands rather than sticking forever.
import { memo, useEffect, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { usePlanFlow } from '../PlanFlowContext';
import type { SourceFrameNodeData } from './nodeData';
import { NodeFrame } from './nodeUi';

const MAX_RETRIES = 6;
const RETRY_MS = 1500;

// Inner image with bounded retry. Keyed by `baseSrc` in the parent so a new plan
// or scene boundary remounts it and restarts the retries from zero — no
// state-sync-from-props effect needed.
function FrameImg({ baseSrc, label, aspectRatio }: { baseSrc: string; label: string; aspectRatio: string }) {
  const [retry, setRetry] = useState(0);
  const [exhausted, setExhausted] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Bump a nonce on each retry so the browser re-requests rather than serving its
  // cached 404.
  const src = retry === 0 ? baseSrc : `${baseSrc}&r=${retry}`;

  return (
    <div
      className="relative w-full rounded bg-black/60 border border-zinc-800 overflow-hidden flex items-center justify-center"
      style={{ aspectRatio }}
    >
      {exhausted ? (
        <div className="flex flex-col items-center gap-1 text-zinc-600">
          <ImageOff className="w-4 h-4" />
          <span className="text-[9px] font-mono">no source frame</span>
        </div>
      ) : (
        <img
          src={src}
          alt={label}
          className="w-full h-full object-cover"
          onError={() => {
            if (retry >= MAX_RETRIES) {
              setExhausted(true);
              return;
            }
            timer.current = setTimeout(() => setRetry((r) => r + 1), RETRY_MS);
          }}
        />
      )}
    </div>
  );
}

function SourceFrameNodeImpl({ data }: { data: SourceFrameNodeData }) {
  const { projectSlug, sourceAspect } = usePlanFlow();
  const baseSrc = `/files/${projectSlug}/plan/s${data.sceneIndex + 1}-image${data.frameIndex}-source.jpg?v=${data.cacheBust}`;
  return (
    <NodeFrame label={data.label} accent="border-zinc-600/60">
      <FrameImg key={baseSrc} baseSrc={baseSrc} label={data.label} aspectRatio={sourceAspect.css} />
    </NodeFrame>
  );
}

export const SourceFrameNode = memo(SourceFrameNodeImpl);
