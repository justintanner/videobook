import { useCallback, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";
import { toast } from "@/hooks/useToast";

export const OUTFIT_CUSTOM_PROMPT_MAX = 500;

export const OUTFIT_PLATFORMS = ["ig", "tiktok", "youtube"] as const;
export type OutfitPlatform = typeof OUTFIT_PLATFORMS[number];

export const OUTFIT_MODEL_OPTIONS = [
  { key: "nano_banana_pro", label: "Nano Banana Pro" },
  { key: "qwen_image_edit", label: "Qwen Image Edit" },
  { key: "gpt_image_2", label: "GPT Image 2.0" },
  { key: "wan27_pro", label: "Wan 2.7 Pro" },
  { key: "grok_imagine", label: "Grok Imagine" },
] as const;
export type OutfitModelKey = typeof OUTFIT_MODEL_OPTIONS[number]["key"];

export const OUTFIT_PROVIDERS = [
  { key: "kie", label: "Kie" },
  { key: "fal", label: "Fal" },
] as const;
export type OutfitProvider = typeof OUTFIT_PROVIDERS[number]["key"];

export interface GenerateOutfitArgs {
  projectSlug: string;
  modelImageSlug: string;
  garmentImageSlug: string;
  poseSkeletonBlob: Blob;
  poseSkeletonFilename: string;
  models: OutfitModelKey[];
  provider: OutfitProvider;
  platform?: OutfitPlatform;
  customPrompt?: string;
}

export interface GenerateOutfitResult {
  status: "enqueued" | "failed";
  enqueued: number;
  failed: number;
}

export interface UseGenerateOutfitResult {
  generate: (args: GenerateOutfitArgs) => Promise<GenerateOutfitResult | null>;
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

export function useGenerateOutfit(callTool: UseMcpResult["callTool"]): UseGenerateOutfitResult {
  const [submitting, setSubmitting] = useState(false);
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;
  const inFlightRef = useRef(false);

  const generate = useCallback(async (args: GenerateOutfitArgs): Promise<GenerateOutfitResult | null> => {
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      // 1. Upload the skeleton PNG as a new img-* asset.
      const base64 = await blobToBase64(args.poseSkeletonBlob);
      const uploadRes = await callToolRef.current("upload_file", {
        project_slug: args.projectSlug,
        filename: args.poseSkeletonFilename,
        data: base64,
      });
      if (uploadRes.isError) {
        const content = uploadRes.content as Array<{ type: string; text: string }> | undefined;
        const msg = content?.[0]?.text ?? "upload_file failed";
        toast({ title: "Outfit upload failed", description: msg, duration: 4000 });
        return null;
      }
      const uploadContent = uploadRes.content as Array<{ type: string; text: string }>;
      const uploaded = JSON.parse(uploadContent[0].text) as { assetId: string };
      const poseImageSlug = uploaded.assetId;

      // 2. Call generate_outfit with the three slugs.
      const trimmedCustom = args.customPrompt?.trim();
      const toolArgs: Record<string, unknown> = {
        project_slug: args.projectSlug,
        model_image_slug: args.modelImageSlug,
        garment_image_slug: args.garmentImageSlug,
        pose_image_slug: poseImageSlug,
        models: args.models,
        provider: args.provider,
      };
      if (trimmedCustom) toolArgs.custom_prompt = trimmedCustom;
      if (args.platform) toolArgs.platform = args.platform;
      const result = await callToolRef.current("generate_outfit", toolArgs);
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        const msg = content?.[0]?.text ?? "generate_outfit failed";
        toast({ title: "Generate outfit failed", description: msg, duration: 4000 });
        return null;
      }
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as GenerateOutfitResult;
      const providerLabel = args.provider === "kie" ? "Kie" : "Fal";
      toast({
        title: "Outfit generating",
        description: `${parsed.enqueued} job${parsed.enqueued === 1 ? "" : "s"} queued via ${providerLabel}`,
        duration: 3000,
      });
      await callToolRef.current("sync", { project_slug: args.projectSlug });
      return parsed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Generate outfit failed", description: msg, duration: 4000 });
      return null;
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, []);

  return { generate, submitting };
}
