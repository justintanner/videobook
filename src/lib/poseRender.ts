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

export async function renderSkeletonPng(result: HolisticResult, width: number, height: number): Promise<SkeletonRender> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not acquire 2d context");

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  if (result.pose) drawPose(ctx, width, height, result.pose);
  if (result.face) drawFace(ctx, width, height, result.face);
  for (const hand of result.hands) drawHand(ctx, width, height, hand.landmarks);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
  const dataUrl = canvas.toDataURL("image/png");
  return { blob, dataUrl, width, height };
}

export function countLandmarks(result: HolisticResult): number {
  const p = result.pose?.length ?? 0;
  const f = result.face?.length ?? 0;
  const h = result.hands.reduce((n, hand) => n + hand.landmarks.length, 0);
  return p + f + h;
}
