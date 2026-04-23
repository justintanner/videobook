import { useCallback, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";
import { toast } from "@/hooks/useToast";
import { useBlazePose } from "@/hooks/useBlazePose";

export interface ExtractSkeletonArgs {
  projectSlug: string;
  sourceAssetId: string;
  sourceImageUrl: string;
}

export interface UseExtractSkeletonResult {
  extract: (args: ExtractSkeletonArgs) => Promise<string | null>;
  submitting: boolean;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(",")[1]);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

export function useExtractSkeleton(callTool: UseMcpResult["callTool"]): UseExtractSkeletonResult {
  const { extract: runBlazePose } = useBlazePose();
  const [submitting, setSubmitting] = useState(false);
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;
  const inFlightRef = useRef(false);

  const extract = useCallback(async (args: ExtractSkeletonArgs): Promise<string | null> => {
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const pose = await runBlazePose(args.sourceAssetId, args.sourceImageUrl);
      if (!pose) {
        toast({ title: "Pose extraction failed", description: "No person detected", duration: 4000 });
        return null;
      }
      const base64 = await blobToBase64(pose.skeleton.blob);
      const uploadRes = await callToolRef.current("upload_file", {
        project_slug: args.projectSlug,
        filename: `pose-skeleton-${args.sourceAssetId}.png`,
        data: base64,
      });
      if (uploadRes.isError) {
        const content = uploadRes.content as Array<{ type: string; text: string }> | undefined;
        const msg = content?.[0]?.text ?? "upload_file failed";
        toast({ title: "Skeleton upload failed", description: msg, duration: 4000 });
        return null;
      }
      const content = uploadRes.content as Array<{ type: string; text: string }>;
      const uploaded = JSON.parse(content[0].text) as { assetId: string };
      toast({
        title: "Skeleton extracted",
        description: `${pose.keypoints.length} keypoints · @${uploaded.assetId}`,
        duration: 3000,
      });
      await callToolRef.current("sync", { project_slug: args.projectSlug });
      return uploaded.assetId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Pose extraction failed", description: msg, duration: 4000 });
      return null;
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, [runBlazePose]);

  return { extract, submitting };
}
