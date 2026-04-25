import { useEffect, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";
import type { OutfitModelKey, OutfitPlatform, OutfitPoseCoverage, OutfitProvider } from "./useGenerateOutfit";

export interface OutfitPromptPreviewEntry {
  model: OutfitModelKey;
  provider: OutfitProvider;
  prompt: string;
  image_count: number;
  backdrop_mentioned?: boolean;
}

export interface UseOutfitPromptPreviewArgs {
  callTool: UseMcpResult["callTool"];
  callState: UseMcpResult["state"];
  projectSlug: string | null;
  modelImageSlug: string | null;
  models: OutfitModelKey[];
  provider: OutfitProvider;
  hasBackdrop: boolean;
  poseDescription: string | null;
  shot: string | null;
  platform: OutfitPlatform | null;
  poseCoverage: OutfitPoseCoverage | null;
}

export interface UseOutfitPromptPreviewResult {
  prompts: OutfitPromptPreviewEntry[];
  negativePrompt: string | null;
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 250;

export function useOutfitPromptPreview({
  callTool,
  callState,
  projectSlug,
  modelImageSlug,
  models,
  provider,
  hasBackdrop,
  poseDescription,
  shot,
  platform,
  poseCoverage,
}: UseOutfitPromptPreviewArgs): UseOutfitPromptPreviewResult {
  const [prompts, setPrompts] = useState<OutfitPromptPreviewEntry[]>([]);
  const [negativePrompt, setNegativePrompt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;
  const requestIdRef = useRef(0);

  const modelsKey = models.join(",");

  useEffect(() => {
    if (callState !== "ready") return;
    if (models.length === 0) {
      setPrompts([]);
      setError(null);
      setLoading(false);
      return;
    }
    const reqId = ++requestIdRef.current;
    setLoading(true);
    const timer = setTimeout(() => {
      const args: Record<string, unknown> = {
        models,
        provider,
        has_backdrop: hasBackdrop,
      };
      if (projectSlug) args.project_slug = projectSlug;
      if (modelImageSlug) args.model_image_slug = modelImageSlug;
      if (poseDescription) args.pose_description = poseDescription;
      if (shot) args.pose_shot = shot;
      if (platform) args.platform = platform;
      if (poseCoverage) args.pose_coverage = poseCoverage;
      callToolRef.current("preview_outfit_prompts", args).then(
        (result) => {
          if (reqId !== requestIdRef.current) return;
          if (result.isError) {
            const content = result.content as Array<{ type: string; text: string }> | undefined;
            setError(content?.[0]?.text ?? "preview_outfit_prompts failed");
            setLoading(false);
            return;
          }
          const content = result.content as Array<{ type: string; text: string }>;
          try {
            const parsed = JSON.parse(content[0].text) as {
              prompts: OutfitPromptPreviewEntry[];
              negative_prompt?: string;
            };
            setPrompts(parsed.prompts);
            setNegativePrompt(parsed.negative_prompt ?? null);
            setError(null);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setLoading(false);
          }
        },
        (e: unknown) => {
          if (reqId !== requestIdRef.current) return;
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [callState, projectSlug, modelImageSlug, modelsKey, provider, hasBackdrop, poseDescription, shot, platform, poseCoverage, models]);

  return { prompts, negativePrompt, loading, error };
}
