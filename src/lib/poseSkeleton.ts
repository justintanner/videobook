import type { Keypoint } from "@tensorflow-models/pose-detection";
import { getAdjacentPairs } from "./blazepose";

const KEYPOINT_SCORE_THRESHOLD = 0.3;
const KEYPOINT_RADIUS = 3;
const BONE_WIDTH = 4;

function hsl(hue: number, sat: number, light: number): string {
  return `hsl(${hue.toFixed(0)} ${sat}% ${light}%)`;
}

export interface SkeletonRender {
  blob: Blob;
  dataUrl: string;
  width: number;
  height: number;
}

export async function renderSkeletonPng(
  keypoints: Keypoint[],
  width: number,
  height: number,
): Promise<SkeletonRender> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not acquire 2d context");

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  const pairs = await getAdjacentPairs();
  ctx.lineWidth = BONE_WIDTH;
  ctx.lineCap = "round";
  pairs.forEach(([a, b], idx) => {
    const ka = keypoints[a];
    const kb = keypoints[b];
    if (!ka || !kb) return;
    if ((ka.score ?? 0) < KEYPOINT_SCORE_THRESHOLD) return;
    if ((kb.score ?? 0) < KEYPOINT_SCORE_THRESHOLD) return;
    const hue = (idx * 360) / pairs.length;
    ctx.strokeStyle = hsl(hue, 85, 55);
    ctx.beginPath();
    ctx.moveTo(ka.x, ka.y);
    ctx.lineTo(kb.x, kb.y);
    ctx.stroke();
  });

  keypoints.forEach((kp, i) => {
    if ((kp.score ?? 0) < KEYPOINT_SCORE_THRESHOLD) return;
    // Face keypoints (indices 0-10 in BlazePose) render as small white dots,
    // body keypoints render as larger red dots — mirrors the reference screenshot.
    const isFace = i <= 10;
    ctx.fillStyle = isFace ? "#fff" : "#f43f5e";
    ctx.beginPath();
    ctx.arc(kp.x, kp.y, isFace ? KEYPOINT_RADIUS - 1 : KEYPOINT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  });

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
  const dataUrl = canvas.toDataURL("image/png");
  return { blob, dataUrl, width, height };
}
