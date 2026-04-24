import { useEffect, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";
import type { OutfitModelKey, OutfitPlatform, OutfitProvider } from "./useGenerateOutfit";

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
  models: OutfitModelKey[];
  provider: OutfitProvider;
  hasBackdrop: boolean;
  platform: OutfitPlatform | null;
}

export interface UseOutfitPromptPreviewResult {
  prompts: OutfitPromptPreviewEntry[];
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 250;

export function useOutfitPromptPreview({
  callTool,
  callState,
  models,
  provider,
  hasBackdrop,
  platform,
}: UseOutfitPromptPreviewArgs): UseOutfitPromptPreviewResult {
  const [prompts, setPrompts] = useState<OutfitPromptPreviewEntry[]>([]);
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
      if (platform) args.platform = platform;
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
            const parsed = JSON.parse(content[0].text) as { prompts: OutfitPromptPreviewEntry[] };
            setPrompts(parsed.prompts);
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
  }, [callState, modelsKey, provider, hasBackdrop, platform, models]);

  return { prompts, loading, error };
}
