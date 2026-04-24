import type { HolisticResult, NormalizedLandmark } from "./poseExtract";

export interface SkeletonRender {
  blob: Blob;
  dataUrl: string;
  width: number;
  height: number;
}

const VISIBILITY_THRESHOLD = 0.3;

type Conn = [number, number, string];

const POSE_CONNECTIONS: Conn[] = [
  [11, 12, "#1e90ff"], [11, 23, "#1e90ff"], [12, 24, "#1e90ff"], [23, 24, "#1e90ff"],
  [11, 13, "#16a34a"], [13, 15, "#22c55e"], [15, 17, "#22c55e"], [15, 19, "#22c55e"], [15, 21, "#22c55e"], [17, 19, "#22c55e"],
  [12, 14, "#06b6d4"], [14, 16, "#0891b2"], [16, 18, "#0891b2"], [16, 20, "#0891b2"], [16, 22, "#0891b2"], [18, 20, "#0891b2"],
  [23, 25, "#eab308"], [25, 27, "#f59e0b"], [27, 29, "#f59e0b"], [27, 31, "#f59e0b"], [29, 31, "#f59e0b"],
  [24, 26, "#84cc16"], [26, 28, "#65a30d"], [28, 30, "#65a30d"], [28, 32, "#65a30d"], [30, 32, "#65a30d"],
  [0, 11, "#b91c1c"], [0, 12, "#b91c1c"],
];

const POSE_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const POSE_ANCHOR_JOINTS = new Set([11, 12, 23, 24]);

const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
const FINGER_COLORS = ["#f59e0b", "#ec4899", "#a855f7", "#22d3ee", "#84cc16"];

function fingerOf(landmarkIndex: number): number {
  return landmarkIndex === 0 ? 0 : Math.floor((landmarkIndex - 1) / 4);
}

function visible(p: NormalizedLandmark | undefined): boolean {
  if (!p) return false;
  const v = p.visibility ?? 1;
  return v >= VISIBILITY_THRESHOLD;
}

function drawPose(ctx: CanvasRenderingContext2D, W: number, H: number, pose: NormalizedLandmark[]): void {
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(3, W / 160);
  for (const [a, b, color] of POSE_CONNECTIONS) {
    const pa = pose[a], pb = pose[b];
    if (!visible(pa) || !visible(pb)) continue;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(pa.x * W, pa.y * H);
    ctx.lineTo(pb.x * W, pb.y * H);
    ctx.stroke();
  }
  const r = Math.max(3, W / 260);
  for (const i of POSE_JOINTS) {
    const p = pose[i];
    if (!visible(p)) continue;
    ctx.fillStyle = POSE_ANCHOR_JOINTS.has(i) ? "#06b6d4" : "#ef4444";
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFace(ctx: CanvasRenderingContext2D, W: number, H: number, face: NormalizedLandmark[]): void {
  ctx.fillStyle = "#fff";
  const r = Math.max(1, W / 640);
  for (const p of face) {
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHand(ctx: CanvasRenderingContext2D, W: number, H: number, hand: NormalizedLandmark[]): void {
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2, W / 240);
  for (const [a, b] of HAND_CONNECTIONS) {
    const pa = hand[a], pb = hand[b];
    if (!pa || !pb) continue;
    const f = fingerOf(b === 0 ? a : b);
    ctx.strokeStyle = FINGER_COLORS[f] ?? "#22d3ee";
    ctx.beginPath();
    ctx.moveTo(pa.x * W, pa.y * H);
    ctx.lineTo(pb.x * W, pb.y * H);
    ctx.stroke();
  }
  ctx.fillStyle = "#ef4444";
  const r = Math.max(2, W / 320);
  for (const p of hand) {
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

interface SubjectBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Subject bbox in source-image normalized coords, over all visible landmarks.
// Returns null when nothing passes the visibility threshold.
function computeSubjectBBox(result: HolisticResult): SubjectBBox | null {
  const pts: NormalizedLandmark[] = [];
  if (result.pose) {
    for (const p of result.pose) {
      if ((p.visibility ?? 1) >= VISIBILITY_THRESHOLD) pts.push(p);
    }
  }
  if (result.face) pts.push(...result.face);
  for (const hand of result.hands) pts.push(...hand.landmarks);
  if (pts.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

export interface RenderSkeletonOptions {
  // Target aspect ratio as W/H (e.g., 9/16 for portrait, 16/9 for landscape).
  aspectRatio: number;
  // Fractional margin around the subject in the output canvas on each side
  // (0..0.4). Defaults to 0.1 — 10% of the canvas on each edge.
  padding?: number;
  // Output canvas long-edge in pixels. Defaults to 1280.
  longEdge?: number;
}

// Reframe the skeleton onto a canvas at the requested aspect ratio, with the
// detected subject centered and padded. The pose is NOT rescaled isotropically
// relative to itself — we construct a virtual canvas in source-pixel space
// that (a) has the target AR and (b) contains the subject's bbox with margin,
// then map landmarks onto the output canvas. Points that fall outside the
// virtual canvas (e.g., a wrist reaching beyond the padding) still draw —
// canvas clips them at the edge rather than distorting the pose.
export async function renderSkeletonPng(
  result: HolisticResult,
  srcW: number,
  srcH: number,
  opts: RenderSkeletonOptions,
): Promise<SkeletonRender> {
  const aspectRatio = opts.aspectRatio;
  const padding = Math.max(0, Math.min(0.4, opts.padding ?? 0.1));
  const longEdge = opts.longEdge ?? 1280;

  // Virtual canvas in source-pixel coordinates.
  let vx0: number;
  let vy0: number;
  let vw: number;
  let vh: number;
  const bbox = computeSubjectBBox(result);
  if (bbox) {
    const bx0 = bbox.x0 * srcW;
    const by0 = bbox.y0 * srcH;
    const bx1 = bbox.x1 * srcW;
    const by1 = bbox.y1 * srcH;
    const bw = bx1 - bx0;
    const bh = by1 - by0;
    const interior = 1 - 2 * padding;
    // canvasW = canvasH * aspectRatio, and both dims must leave `padding` on
    // each side around the subject bbox.
    const canvasH = Math.max(bh / interior, bw / (interior * aspectRatio));
    const canvasW = canvasH * aspectRatio;
    const cx = (bx0 + bx1) / 2;
    const cy = (by0 + by1) / 2;
    vx0 = cx - canvasW / 2;
    vy0 = cy - canvasH / 2;
    vw = canvasW;
    vh = canvasH;
  } else {
    // No subject detected — letterbox the source frame into the target AR.
    const srcAr = srcW / srcH;
    if (srcAr >= aspectRatio) {
      vh = srcH;
      vw = vh * aspectRatio;
    } else {
      vw = srcW;
      vh = vw / aspectRatio;
    }
    vx0 = (srcW - vw) / 2;
    vy0 = (srcH - vh) / 2;
  }

  // Output pixel dims: long edge = `longEdge`.
  let outW: number;
  let outH: number;
  if (aspectRatio >= 1) {
    outW = longEdge;
    outH = longEdge / aspectRatio;
  } else {
    outH = longEdge;
    outW = longEdge * aspectRatio;
  }
  outW = Math.round(outW);
  outH = Math.round(outH);

  const transform = (p: NormalizedLandmark): NormalizedLandmark => ({
    x: (p.x * srcW - vx0) / vw,
    y: (p.y * srcH - vy0) / vh,
    z: p.z,
    visibility: p.visibility,
  });

  const transformed: HolisticResult = {
    pose: result.pose ? result.pose.map(transform) : null,
    face: result.face ? result.face.map(transform) : null,
    hands: result.hands.map((h) => ({
      landmarks: h.landmarks.map(transform),
      handedness: h.handedness,
    })),
  };

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not acquire 2d context");

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, outW, outH);

  if (transformed.pose) drawPose(ctx, outW, outH, transformed.pose);
  if (transformed.face) drawFace(ctx, outW, outH, transformed.face);
  for (const hand of transformed.hands) drawHand(ctx, outW, outH, hand.landmarks);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
  const dataUrl = canvas.toDataURL("image/png");
  return { blob, dataUrl, width: outW, height: outH };
}

export function countLandmarks(result: HolisticResult): number {
  const p = result.pose?.length ?? 0;
  const f = result.face?.length ?? 0;
  const h = result.hands.reduce((n, hand) => n + hand.landmarks.length, 0);
  return p + f + h;
}
