import { useCallback, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";
import { toast } from "@/hooks/useToast";

export const POSE_PLATFORMS = ["ig", "tiktok", "youtube"] as const;
export type PosePlatform = typeof POSE_PLATFORMS[number];

export const POSE_MODEL_OPTIONS = [
  { key: "nano_banana_pro", label: "Nano Banana Pro" },
  { key: "qwen_image_edit", label: "Qwen Image Edit" },
  { key: "gpt_image_2", label: "GPT Image 2.0" },
  { key: "wan27_pro", label: "Wan 2.7 Pro" },
  { key: "grok_imagine", label: "Grok Imagine" },
] as const;
export type PoseModelKey = typeof POSE_MODEL_OPTIONS[number]["key"];

export const POSE_PROVIDERS = [
  { key: "kie", label: "Kie" },
  { key: "fal", label: "Fal" },
] as const;
export type PoseProvider = typeof POSE_PROVIDERS[number]["key"];

export const POSE_TYPE_OPTIONS = [
  { key: "selfie", label: "Selfie" },
  { key: "mirror_selfie", label: "Mirror Selfie" },
  { key: "portrait", label: "Portrait" },
  { key: "full_body", label: "Full Body" },
  { key: "candid", label: "Candid" },
  { key: "action", label: "Action" },
  { key: "close_up", label: "Close-up" },
  { key: "pov", label: "POV" },
  { key: "group", label: "Group" },
] as const;
export type PoseType = typeof POSE_TYPE_OPTIONS[number]["key"];

export const POSE_COUNT_MIN = 1;
export const POSE_COUNT_MAX = 6;
export const POSE_COUNT_DEFAULT = 3;

export const CUSTOM_PROMPT_MAX = 500;

export interface GeneratePosesArgs {
  sourceSlugs: string[];
  platforms: PosePlatform[];
  models: PoseModelKey[];
  provider: PoseProvider;
  posesPerPlatform: number;
  poseType?: PoseType;
  customPrompt?: string;
  projectSlug: string;
}

export interface GeneratePosesResult {
  status: "enqueued" | "failed";
  enqueued: number;
  failed: number;
  research_errors: string[];
}

export interface UseGeneratePosesResult {
  generate: (args: GeneratePosesArgs) => Promise<GeneratePosesResult | null>;
  submitting: boolean;
}

export function useGeneratePoses(callTool: UseMcpResult["callTool"]): UseGeneratePosesResult {
  const [submitting, setSubmitting] = useState(false);
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;
  const inFlightRef = useRef(false);

  const generate = useCallback(async (args: GeneratePosesArgs): Promise<GeneratePosesResult | null> => {
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const trimmedCustom = args.customPrompt?.trim();
      const toolArgs: Record<string, unknown> = {
        project_slug: args.projectSlug,
        source_slugs: args.sourceSlugs.map((s) => (s.startsWith("@") ? s : `@${s}`)),
        platforms: args.platforms,
        models: args.models,
        provider: args.provider,
        poses_per_platform: args.posesPerPlatform,
      };
      if (args.poseType) toolArgs.pose_type = args.poseType;
      if (trimmedCustom) toolArgs.custom_prompt = trimmedCustom;
      const result = await callToolRef.current(
        "generate_poses",
        toolArgs as unknown as Record<string, unknown>,
      );
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        const msg = content?.[0]?.text ?? "generate_poses failed";
        toast({ title: "Generate poses failed", description: msg, duration: 4000 });
        return null;
      }
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as GeneratePosesResult;
      const providerLabel = args.provider === "kie" ? "Kie" : "Fal";
      const desc = parsed.research_errors.length > 0
        ? `${parsed.enqueued} jobs queued via ${providerLabel} · ${parsed.research_errors.length} research errors`
        : `${parsed.enqueued} jobs queued via ${providerLabel}`;
      toast({ title: "Poses generating", description: desc, duration: 3000 });
      await callToolRef.current("sync", { project_slug: args.projectSlug });
      return parsed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Generate poses failed", description: msg, duration: 4000 });
      return null;
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, []);

  return { generate, submitting };
}
