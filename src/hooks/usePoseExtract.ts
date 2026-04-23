import { useCallback, useRef, useState } from "react";
import { detectHolistic, loadImage, type HolisticResult } from "@/lib/poseExtract";
import { renderSkeletonPng, countLandmarks, type SkeletonRender } from "@/lib/poseRender";

export interface PoseExtraction {
  sourceAssetId: string;
  holistic: HolisticResult;
  skeleton: SkeletonRender;
  landmarkCount: number;
}

export interface UsePoseExtractResult {
  extract: (sourceAssetId: string, imageUrl: string) => Promise<PoseExtraction | null>;
  reset: () => void;
  result: PoseExtraction | null;
  loading: boolean;
  error: string | null;
}

export function usePoseExtract(): UsePoseExtractResult {
  const [result, setResult] = useState<PoseExtraction | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef<string | null>(null);

  const extract = useCallback(async (sourceAssetId: string, imageUrl: string): Promise<PoseExtraction | null> => {
    if (inFlightRef.current === sourceAssetId) return null;
    inFlightRef.current = sourceAssetId;
    setLoading(true);
    setError(null);
    try {
      const img = await loadImage(imageUrl);
      const holistic = await detectHolistic(img);
      if (!holistic.pose && !holistic.face && holistic.hands.length === 0) {
        setError("No person detected in this image.");
        setResult(null);
        return null;
      }
      const skeleton = await renderSkeletonPng(holistic, img.naturalWidth, img.naturalHeight);
      const extraction: PoseExtraction = {
        sourceAssetId,
        holistic,
        skeleton,
        landmarkCount: countLandmarks(holistic),
      };
      setResult(extraction);
      return extraction;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setResult(null);
      return null;
    } finally {
      inFlightRef.current = null;
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
    inFlightRef.current = null;
  }, []);

  return { extract, reset, result, loading, error };
}
