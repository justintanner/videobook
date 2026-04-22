import type { Keypoint, PoseDetector } from "@tensorflow-models/pose-detection";

type PoseDetectionModule = typeof import("@tensorflow-models/pose-detection");

let modulePromise: Promise<PoseDetectionModule> | null = null;
let detectorPromise: Promise<PoseDetector> | null = null;

function loadModule(): Promise<PoseDetectionModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const tf = await import("@tensorflow/tfjs");
      await tf.setBackend("webgl");
      await tf.ready();
      return import("@tensorflow-models/pose-detection");
    })();
  }
  return modulePromise;
}

async function getDetector(): Promise<PoseDetector> {
  if (!detectorPromise) {
    detectorPromise = loadModule().then((poseDetection) =>
      poseDetection.createDetector(
        poseDetection.SupportedModels.BlazePose,
        { runtime: "tfjs", modelType: "full" },
      ),
    );
  }
  return detectorPromise;
}

export async function detectKeypoints(
  image: HTMLImageElement | HTMLCanvasElement,
): Promise<Keypoint[] | null> {
  const detector = await getDetector();
  const poses = await detector.estimatePoses(image, { flipHorizontal: false });
  if (poses.length === 0) return null;
  return poses[0].keypoints;
}

export async function getAdjacentPairs(): Promise<Array<[number, number]>> {
  const poseDetection = await loadModule();
  return poseDetection.util.getAdjacentPairs(poseDetection.SupportedModels.BlazePose) as Array<[number, number]>;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load image: ${url}`));
    img.src = url;
  });
}

export type { Keypoint } from "@tensorflow-models/pose-detection";
