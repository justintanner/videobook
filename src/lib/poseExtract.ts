import {
  FilesetResolver,
  PoseLandmarker,
  FaceLandmarker,
  HandLandmarker,
  type NormalizedLandmark,
  type Category,
} from "@mediapipe/tasks-vision";

const WASM_BASE = "/mediapipe-wasm";
const POSE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

const HEAD_POSE_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const FACE_CROP_PADDING = 0.8;
const FACE_CROP_SIZE = 512;
const HEAD_VISIBILITY_THRESHOLD = 0.3;

export type Handedness = "Left" | "Right" | "Unknown";

export interface HolisticResult {
  pose: NormalizedLandmark[] | null;
  face: NormalizedLandmark[] | null;
  hands: Array<{ landmarks: NormalizedLandmark[]; handedness: Handedness }>;
}

interface Detectors {
  pose: PoseLandmarker;
  face: FaceLandmarker;
  hand: HandLandmarker;
}

let detectorsPromise: Promise<Detectors> | null = null;

async function getDetectors(): Promise<Detectors> {
  if (!detectorsPromise) {
    detectorsPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      const [pose, face, hand] = await Promise.all([
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
          runningMode: "IMAGE",
          numPoses: 1,
        }),
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
          runningMode: "IMAGE",
          numFaces: 1,
          outputFaceBlendshapes: false,
        }),
        HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" },
          runningMode: "IMAGE",
          numHands: 2,
        }),
      ]);
      return { pose, face, hand };
    })();
  }
  return detectorsPromise;
}

function toHandedness(cats: Category[] | undefined): Handedness {
  const name = cats?.[0]?.categoryName;
  if (name === "Left" || name === "Right") return name;
  return "Unknown";
}

interface FaceRoi {
  x: number;
  y: number;
  size: number;
}

function computeHeadRoi(pose: NormalizedLandmark[], imgW: number, imgH: number): FaceRoi | null {
  const pts = HEAD_POSE_INDICES
    .map((i) => pose[i])
    .filter((p): p is NormalizedLandmark => !!p && (p.visibility ?? 1) >= HEAD_VISIBILITY_THRESHOLD);
  if (pts.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    const x = p.x * imgW;
    const y = p.y * imgH;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY);
  const size = Math.min(imgW, imgH, span * (1 + FACE_CROP_PADDING * 2));
  const x = Math.max(0, Math.min(imgW - size, cx - size / 2));
  const y = Math.max(0, Math.min(imgH - size, cy - size / 2));
  return { x, y, size };
}

function cropToCanvas(
  image: HTMLImageElement | HTMLCanvasElement,
  roi: FaceRoi,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = FACE_CROP_SIZE;
  canvas.height = FACE_CROP_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not acquire 2d context for face crop");
  ctx.drawImage(image, roi.x, roi.y, roi.size, roi.size, 0, 0, FACE_CROP_SIZE, FACE_CROP_SIZE);
  return canvas;
}

function remapFaceLandmarks(
  landmarks: NormalizedLandmark[],
  roi: FaceRoi,
  imgW: number,
  imgH: number,
): NormalizedLandmark[] {
  return landmarks.map((p) => ({
    x: (roi.x + p.x * roi.size) / imgW,
    y: (roi.y + p.y * roi.size) / imgH,
    z: p.z,
    visibility: p.visibility,
  }));
}

function imageDimensions(image: HTMLImageElement | HTMLCanvasElement): { w: number; h: number } {
  if (image instanceof HTMLCanvasElement) return { w: image.width, h: image.height };
  return { w: image.naturalWidth, h: image.naturalHeight };
}

export async function detectHolistic(image: HTMLImageElement | HTMLCanvasElement): Promise<HolisticResult> {
  const { pose, face, hand } = await getDetectors();
  const { w: imgW, h: imgH } = imageDimensions(image);

  const poseRes = pose.detect(image);
  const poseLandmarks = poseRes.landmarks[0] ?? null;

  let faceLandmarks: NormalizedLandmark[] | null = null;
  const fullFrameFace = face.detect(image);
  if (fullFrameFace.faceLandmarks[0]) {
    faceLandmarks = fullFrameFace.faceLandmarks[0];
  } else if (poseLandmarks) {
    const roi = computeHeadRoi(poseLandmarks, imgW, imgH);
    if (roi) {
      const cropped = cropToCanvas(image, roi);
      const cropFace = face.detect(cropped);
      if (cropFace.faceLandmarks[0]) {
        faceLandmarks = remapFaceLandmarks(cropFace.faceLandmarks[0], roi, imgW, imgH);
      }
    }
  }

  const handRes = hand.detect(image);
  const hands = handRes.landmarks.map((landmarks, i) => ({
    landmarks,
    handedness: toHandedness(handRes.handedness[i]),
  }));

  return {
    pose: poseLandmarks,
    face: faceLandmarks,
    hands,
  };
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load image: ${url}`));
    img.src = url;
  });
}

export type { NormalizedLandmark };
