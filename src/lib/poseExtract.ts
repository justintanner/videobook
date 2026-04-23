import {
  FilesetResolver,
  PoseLandmarker,
  FaceLandmarker,
  HandLandmarker,
  type NormalizedLandmark,
  type Category,
} from "@mediapipe/tasks-vision";

const MEDIAPIPE_VERSION = "0.10.21";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const POSE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

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

export async function detectHolistic(image: HTMLImageElement | HTMLCanvasElement): Promise<HolisticResult> {
  const { pose, face, hand } = await getDetectors();
  const poseRes = pose.detect(image);
  const faceRes = face.detect(image);
  const handRes = hand.detect(image);
  const hands = handRes.landmarks.map((landmarks, i) => ({
    landmarks,
    handedness: toHandedness(handRes.handedness[i]),
  }));
  return {
    pose: poseRes.landmarks[0] ?? null,
    face: faceRes.faceLandmarks[0] ?? null,
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
