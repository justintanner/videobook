import {
  FilesetResolver,
  PoseLandmarker,
  FaceLandmarker,
  HandLandmarker,
  type NormalizedLandmark,
  type Category,
} from "@mediapipe/tasks-vision";

const WASM_BASE = "/mediapipe-wasm";
const POSE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

const HEAD_POSE_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const FACE_CROP_PADDING = 0.8;
const FACE_CROP_SIZE = 512;
const HEAD_VISIBILITY_THRESHOLD = 0.3;

// MediaPipe pose landmarks carry a few hand points per side:
//   left:  15 wrist, 17 pinky, 19 index, 21 thumb
//   right: 16 wrist, 18 pinky, 20 index, 22 thumb
// We use these to crop a high-res ROI around each hand and re-run the hand
// landmarker on the crop. This measurably improves finger landmark accuracy
// vs. running the detector on the full image (where hands are often small).
const LEFT_HAND_POSE_INDICES = [15, 17, 19, 21];
const RIGHT_HAND_POSE_INDICES = [16, 18, 20, 22];
const HAND_CROP_PADDING = 1.0;
const HAND_CROP_SIZE = 512;
const HAND_VISIBILITY_THRESHOLD = 0.3;

export type Handedness = "Left" | "Right" | "Unknown";
export type PoseCoverage = "face" | "upper" | "full";

export interface HolisticResult {
  pose: NormalizedLandmark[] | null;
  face: NormalizedLandmark[] | null;
  hands: Array<{ landmarks: NormalizedLandmark[]; handedness: Handedness }>;
}

// MediaPipe pose indices: 11/12 shoulders, 23/24 hips, 27/28 ankles.
// A pose reference that only shows a headshot yields pose landmarks for the
// head cluster but shoulders/hips/ankles are low-visibility — downstream
// image models then lack any structural cue for the body and freestyle it.
// Classify coverage so the prompt builder can swap the "align to pose
// reference" clause for an explicit textual stance directive when the
// reference is face-only.
const COVERAGE_VISIBILITY_THRESHOLD = 0.5;
export function poseCoverage(holistic: HolisticResult): PoseCoverage {
  const pose = holistic.pose;
  if (!pose) return "face";
  const visible = (i: number): boolean => (pose[i]?.visibility ?? 0) >= COVERAGE_VISIBILITY_THRESHOLD;
  const shoulders = visible(11) && visible(12);
  const hips = visible(23) && visible(24);
  const ankles = visible(27) && visible(28);
  if (shoulders && hips && ankles) return "full";
  if (shoulders) return "upper";
  return "face";
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

interface SquareRoi {
  x: number;
  y: number;
  size: number;
}

function computeSquareRoi(
  pose: NormalizedLandmark[],
  indices: number[],
  visibilityThreshold: number,
  paddingFactor: number,
  imgW: number,
  imgH: number,
  minPoints: number,
): SquareRoi | null {
  const pts = indices
    .map((i) => pose[i])
    .filter((p): p is NormalizedLandmark => !!p && (p.visibility ?? 1) >= visibilityThreshold);
  if (pts.length < minPoints) return null;
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
  const size = Math.min(imgW, imgH, span * (1 + paddingFactor * 2));
  const x = Math.max(0, Math.min(imgW - size, cx - size / 2));
  const y = Math.max(0, Math.min(imgH - size, cy - size / 2));
  return { x, y, size };
}

function cropToCanvas(
  image: HTMLImageElement | HTMLCanvasElement,
  roi: SquareRoi,
  outputSize: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not acquire 2d context for crop");
  ctx.drawImage(image, roi.x, roi.y, roi.size, roi.size, 0, 0, outputSize, outputSize);
  return canvas;
}

function remapRoiLandmarks(
  landmarks: NormalizedLandmark[],
  roi: SquareRoi,
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

// Average per-pixel chroma below this is treated as grayscale. Sum of
// |R-G| + |G-B| + |R-B| per pixel; pure B&W returns ~0, JPEG-encoded B&W
// with chroma noise lands ~40, even desaturated color shots clear 70+.
const GRAYSCALE_CHROMA_THRESHOLD = 60;

function isLikelyGrayscale(image: HTMLImageElement | HTMLCanvasElement): boolean {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(image, 0, 0, 32, 32);
  const px = ctx.getImageData(0, 0, 32, 32).data;
  let total = 0;
  for (let i = 0; i < px.length; i += 4) {
    total += Math.abs(px[i] - px[i + 1]) + Math.abs(px[i + 1] - px[i + 2]) + Math.abs(px[i] - px[i + 2]);
  }
  return total / (32 * 32) < GRAYSCALE_CHROMA_THRESHOLD;
}

// MediaPipe Pose / Face / Hand models are trained on color RGB photos and
// return zero landmarks on monochrome imagery — verified empirically on
// img-play (full B&W → no detection at all; same image with this curve
// applied → all 33 pose + 478 face landmarks). Lifts shadows (gamma 0.55)
// then maps luminance into a warm skin-tone palette so the detector sees
// chroma in the range it was trained on. The colorization is for detection
// only; landmarks are normalized coords that still apply to the original.
function colorizeForPose(image: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement {
  const { w, h } = imageDimensions(image);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("could not acquire 2d context for colorize");
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    // Rec. 601 luminance — handles both true grayscale and accidentally-routed
    // low-chroma color images without collapsing to one channel's bias.
    const y = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
    const lifted = Math.pow(y, 0.55);
    px[i]     = Math.min(255, Math.round(255 * Math.pow(lifted, 0.85) * 1.05));
    px[i + 1] = Math.min(255, Math.round(255 * Math.pow(lifted, 0.95) * 0.92));
    px[i + 2] = Math.min(255, Math.round(255 * Math.pow(lifted, 1.10) * 0.78));
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

export async function detectHolistic(image: HTMLImageElement | HTMLCanvasElement): Promise<HolisticResult> {
  const { pose, face, hand } = await getDetectors();
  // Colorize before detection if the source is monochrome; landmarks are
  // normalized so they still map to the original image downstream.
  const detectionImage: HTMLImageElement | HTMLCanvasElement = isLikelyGrayscale(image)
    ? colorizeForPose(image)
    : image;
  const { w: imgW, h: imgH } = imageDimensions(detectionImage);

  const poseRes = pose.detect(detectionImage);
  const poseLandmarks = poseRes.landmarks[0] ?? null;

  let faceLandmarks: NormalizedLandmark[] | null = null;
  const fullFrameFace = face.detect(detectionImage);
  if (fullFrameFace.faceLandmarks[0]) {
    faceLandmarks = fullFrameFace.faceLandmarks[0];
  } else if (poseLandmarks) {
    const roi = computeSquareRoi(poseLandmarks, HEAD_POSE_INDICES, HEAD_VISIBILITY_THRESHOLD, FACE_CROP_PADDING, imgW, imgH, 3);
    if (roi) {
      const cropped = cropToCanvas(detectionImage, roi, FACE_CROP_SIZE);
      const cropFace = face.detect(cropped);
      if (cropFace.faceLandmarks[0]) {
        faceLandmarks = remapRoiLandmarks(cropFace.faceLandmarks[0], roi, imgW, imgH);
      }
    }
  }

  // Two-pass hand detection. When pose landmarks are available, crop a
  // high-res ROI around each wrist/finger cluster and re-run the hand
  // landmarker on the crop — this gives finger-level landmarks that are far
  // more accurate than whole-frame detection when the hand is small in the
  // source image. Fall back to whole-frame detection when pose is missing.
  const hands: HolisticResult["hands"] = [];
  if (poseLandmarks) {
    const sides: Array<{ indices: number[]; defaultHandedness: Handedness }> = [
      { indices: LEFT_HAND_POSE_INDICES, defaultHandedness: "Left" },
      { indices: RIGHT_HAND_POSE_INDICES, defaultHandedness: "Right" },
    ];
    for (const { indices, defaultHandedness } of sides) {
      const roi = computeSquareRoi(poseLandmarks, indices, HAND_VISIBILITY_THRESHOLD, HAND_CROP_PADDING, imgW, imgH, 2);
      if (!roi) continue;
      const cropped = cropToCanvas(detectionImage, roi, HAND_CROP_SIZE);
      const cropHand = hand.detect(cropped);
      if (!cropHand.landmarks[0]) continue;
      const remapped = remapRoiLandmarks(cropHand.landmarks[0], roi, imgW, imgH);
      const detected = toHandedness(cropHand.handedness[0]);
      // The detector's handedness is flaky on cropped views; trust the pose
      // side (which wrist we cropped around) unless the detector strongly
      // disagrees.
      hands.push({ landmarks: remapped, handedness: detected === "Unknown" ? defaultHandedness : detected });
    }
  }
  if (hands.length === 0) {
    const handRes = hand.detect(detectionImage);
    for (let i = 0; i < handRes.landmarks.length; i++) {
      hands.push({
        landmarks: handRes.landmarks[i],
        handedness: toHandedness(handRes.handedness[i]),
      });
    }
  }

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
