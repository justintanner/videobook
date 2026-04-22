import { useCallback, useRef, useState } from "react";
import { detectKeypoints, loadImage, type Keypoint } from "@/lib/blazepose";
import { renderSkeletonPng, type SkeletonRender } from "@/lib/poseSkeleton";

export interface PoseExtraction {
  sourceAssetId: string;
  keypoints: Keypoint[];
  skeleton: SkeletonRender;
}

export interface UseBlazePoseResult {
  extract: (sourceAssetId: string, imageUrl: string) => Promise<PoseExtraction | null>;
  reset: () => void;
  result: PoseExtraction | null;
  loading: boolean;
  error: string | null;
}

export function useBlazePose(): UseBlazePoseResult {
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
      const keypoints = await detectKeypoints(img);
      if (!keypoints) {
        setError("No person detected in this image.");
        setResult(null);
        return null;
      }
      const skeleton = await renderSkeletonPng(keypoints, img.naturalWidth, img.naturalHeight);
      const extraction: PoseExtraction = { sourceAssetId, keypoints, skeleton };
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
