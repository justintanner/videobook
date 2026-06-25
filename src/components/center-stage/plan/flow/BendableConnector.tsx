// An interactive vertical join between two stacked char_swap nodes. Unlike the
// passive `FlowConnector` (a static 1px CSS line shared by storyboard/clip_show),
// this draws an SVG quadratic-bezier the user can BEND by dragging a midpoint
// handle. The bend is a normalized offset { dx, dy } in [-1, 1] (fraction of the
// connector box's half-width / half-height); { 0, 0 } renders a straight line
// identical to FlowConnector. Drag commits on pointer-up; double-click resets.
//
// Endpoints are the box's top-center and bottom-center (the nodes are centered in
// the column), so a straight connector lines up exactly with the old look. The
// handle sits ON the curve: for a quadratic B(0.5) = M we set the control point
// P1 = 2·M − ½(P0 + P2).
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { ConnectorBend } from '../charSwapModel';

const PAD_X = 12; // keep the handle this many px inside the box horizontally
const PAD_Y = 8; //  …and vertically
const STRAIGHT = { dx: 0, dy: 0 } as const;

function clamp(n: number): number {
  return n < -1 ? -1 : n > 1 ? 1 : n;
}

export function BendableConnector({
  bend = STRAIGHT,
  onCommit,
  height = 56,
  title = 'Drag to bend · double-click to reset',
}: {
  bend?: ConnectorBend;
  onCommit: (dx: number, dy: number) => void;
  height?: number;
  title?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingRef = useRef(false);

  const [w, setW] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Displayed geometry: driven live by the drag, otherwise it tracks the
  // persisted `bend` prop. Synced via the render-time adjustment below (not an
  // effect) so a committed bend doesn't snap back during the async save.
  const [local, setLocal] = useState<ConnectorBend>(bend);
  const [syncedBend, setSyncedBend] = useState<ConnectorBend>(bend);
  if (!dragging && (bend.dx !== syncedBend.dx || bend.dy !== syncedBend.dy)) {
    setSyncedBend(bend);
    setLocal(bend);
  }

  // Measure the (responsive) box width so we can draw in pixel coordinates.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fromPointer = useCallback((clientX: number, clientY: number): ConnectorBend => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return STRAIGHT;
    const halfW = rect.width / 2;
    const halfH = rect.height / 2;
    const dx = clamp((clientX - rect.left - halfW) / Math.max(1, halfW - PAD_X));
    const dy = clamp((clientY - rect.top - halfH) / Math.max(1, halfH - PAD_Y));
    return { dx, dy };
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    setDragging(true);
    setLocal(fromPointer(e.clientX, e.clientY));
  }, [fromPointer]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    setLocal(fromPointer(e.clientX, e.clientY));
  }, [fromPointer]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const next = fromPointer(e.clientX, e.clientY);
    setLocal(next);
    onCommit(next.dx, next.dy);
  }, [fromPointer, onCommit]);

  const reset = useCallback(() => {
    draggingRef.current = false;
    setDragging(false);
    setLocal(STRAIGHT);
    onCommit(0, 0);
  }, [onCommit]);

  const h = height;
  const cx = w / 2;
  // Handle position (drawn point), then the control point that puts the curve
  // through it at t = 0.5.
  const handleX = cx + local.dx * Math.max(0, cx - PAD_X);
  const handleY = h / 2 + local.dy * Math.max(0, h / 2 - PAD_Y);
  const ctrlX = 2 * handleX - cx;
  const ctrlY = 2 * handleY - h / 2;
  const path = `M ${cx} 0 Q ${ctrlX} ${ctrlY} ${cx} ${h}`;

  const active = hovered || dragging;
  const bent = local.dx !== 0 || local.dy !== 0;
  const lineColor = active ? 'rgb(16 185 129 / 0.7)' : 'rgb(63 63 70 / 0.6)';
  const dotFill = active || bent ? 'rgb(16 185 129 / 0.9)' : 'rgb(113 113 122 / 0.7)';

  return (
    <div
      ref={wrapRef}
      className="relative flex w-full shrink-0 items-center justify-center"
      style={{ height: h }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {w > 0 && (
        <svg
          ref={svgRef}
          width={w}
          height={h}
          className="overflow-visible"
          aria-hidden
        >
          <path d={path} fill="none" stroke={lineColor} strokeWidth={1} strokeLinecap="round" />
          {/* Larger transparent hit target for easy grabbing */}
          <circle
            cx={handleX}
            cy={handleY}
            r={10}
            fill="transparent"
            className={cn('touch-none', dragging ? 'cursor-grabbing' : 'cursor-grab')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={reset}
          >
            <title>{title}</title>
          </circle>
          {/* Visible handle dot — faint until hovered/bent */}
          <circle
            cx={handleX}
            cy={handleY}
            r={active ? 4 : 3}
            fill={dotFill}
            pointerEvents="none"
          />
        </svg>
      )}
    </div>
  );
}
