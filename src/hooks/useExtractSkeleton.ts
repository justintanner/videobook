import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/hooks/useToast";
import { detectHolistic, loadImage } from "@/lib/poseExtract";
import { countLandmarks, renderSkeletonPng } from "@/lib/poseRender";
import { uploadProjectFile } from "@/lib/upload";

export interface ExtractSkeletonArgs {
  bookId: string;
  sourceAssetId: string;
  sourceImageUrl: string;
}

export interface UseExtractSkeletonResult {
  extract: (args: ExtractSkeletonArgs) => Promise<string | null>;
  submitting: boolean;
}

export function useExtractSkeleton(
  sync: (bookId: string) => void,
): UseExtractSkeletonResult {
  const [submitting, setSubmitting] = useState(false);
  const syncRef = useRef(sync);
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);
  const inFlightRef = useRef(false);

  const extract = useCallback(async (args: ExtractSkeletonArgs): Promise<string | null> => {
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    setSubmitting(true);
    toast({ title: "Extracting pose", description: "Running MediaPipe Holistic…", duration: 2500 });
    try {
      const img = await loadImage(args.sourceImageUrl);
      const holistic = await detectHolistic(img);
      if (!holistic.pose && !holistic.face && holistic.hands.length === 0) {
        toast({ title: "Pose extraction failed", description: "No person detected", duration: 4000 });
        return null;
      }
      // Standalone skeleton asset: keep the source image's aspect ratio.
      const skeleton = await renderSkeletonPng(holistic, img.naturalWidth, img.naturalHeight, {
        aspectRatio: img.naturalWidth / img.naturalHeight,
      });
      const landmarkCount = countLandmarks(holistic);
      const uploaded = await uploadProjectFile(
        args.bookId,
        skeleton.blob,
        `pose-skeleton-${args.sourceAssetId}.png`,
      );
      toast({
        title: "Skeleton extracted",
        description: `${landmarkCount} landmarks · @${uploaded.assetId}`,
        duration: 3000,
      });
      syncRef.current(args.bookId);
      return uploaded.assetId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Pose extraction failed", description: msg, duration: 4000 });
      return null;
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, []);

  return { extract, submitting };
}
