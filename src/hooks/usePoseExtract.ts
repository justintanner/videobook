import { useCallback, useEffect, useRef, useState } from "react";
import { detectHolistic, loadImage, poseCoverage, type HolisticResult, type PoseCoverage } from "@/lib/poseExtract";
import { renderSkeletonPng, countLandmarks, type SkeletonRender } from "@/lib/poseRender";

interface PoseDetection {
  sourceAssetId: string;
  holistic: HolisticResult;
  srcW: number;
  srcH: number;
  landmarkCount: number;
  coverage: PoseCoverage;
}

export interface PoseExtraction extends PoseDetection {
  skeleton: SkeletonRender;
}

export interface UsePoseExtractResult {
  extract: (sourceAssetId: string, imageUrl: string) => Promise<PoseDetection | null>;
  reset: () => void;
  result: PoseExtraction | null;
  loading: boolean;
  error: string | null;
}

export function usePoseExtract(aspectRatio: number): UsePoseExtractResult {
  const [detection, setDetection] = useState<PoseDetection | null>(null);
  const [skeleton, setSkeleton] = useState<SkeletonRender | null>(null);
  const [detectLoading, setDetectLoading] = useState(false);
  const [renderLoading, setRenderLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef<string | null>(null);
  // The skeleton briefly disappears while we re-render for a new aspect ratio,
  // so callers can't reliably dedupe against the public `result`. Track the
  // last-detected asset here instead, independent of render readiness.
  const detectedAssetRef = useRef<string | null>(null);

  const extract = useCallback(async (sourceAssetId: string, imageUrl: string): Promise<PoseDetection | null> => {
    if (inFlightRef.current === sourceAssetId) return null;
    if (detectedAssetRef.current === sourceAssetId) return null;
    inFlightRef.current = sourceAssetId;
    setDetectLoading(true);
    setError(null);
    try {
      const img = await loadImage(imageUrl);
      const holistic = await detectHolistic(img);
      if (!holistic.pose && !holistic.face && holistic.hands.length === 0) {
        setError("No person detected in this image.");
        setDetection(null);
        setSkeleton(null);
        return null;
      }
      const next: PoseDetection = {
        sourceAssetId,
        holistic,
        srcW: img.naturalWidth,
        srcH: img.naturalHeight,
        landmarkCount: countLandmarks(holistic),
        coverage: poseCoverage(holistic),
      };
      detectedAssetRef.current = sourceAssetId;
      setDetection(next);
      return next;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setDetection(null);
      setSkeleton(null);
      return null;
    } finally {
      inFlightRef.current = null;
      setDetectLoading(false);
    }
  }, []);

  // Re-render the skeleton whenever the detection or target aspect changes.
  // Detection is cached — MediaPipe does not re-run when the user flips AR.
  useEffect(() => {
    if (!detection) {
      setSkeleton(null);
      return;
    }
    let cancelled = false;
    setRenderLoading(true);
    renderSkeletonPng(detection.holistic, detection.srcW, detection.srcH, { aspectRatio })
      .then((s) => {
        if (cancelled) return;
        setSkeleton(s);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setSkeleton(null);
      })
      .finally(() => {
        if (cancelled) return;
        setRenderLoading(false);
      });
    return () => { cancelled = true; };
  }, [detection, aspectRatio]);

  const reset = useCallback(() => {
    setDetection(null);
    setSkeleton(null);
    setError(null);
    inFlightRef.current = null;
    detectedAssetRef.current = null;
  }, []);

  const result: PoseExtraction | null = detection && skeleton ? { ...detection, skeleton } : null;
  return { extract, reset, result, loading: detectLoading || renderLoading, error };
}
