import { useCallback, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";
import { normalizeCharacterProfile, type CharacterProfile, type LegacyCharacterProfile } from "@/hooks/useCharacterSlots";
import { toast } from "@/hooks/useToast";

export interface UseAnalyzeCharacterImageResult {
  analyze: (projectSlug: string, imageSlug: string) => Promise<CharacterProfile | null>;
  loading: boolean;
  error: string | null;
}

export function useAnalyzeCharacterImage(callTool: UseMcpResult["callTool"]): UseAnalyzeCharacterImageResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;

  const analyze = useCallback(async (projectSlug: string, imageSlug: string): Promise<CharacterProfile | null> => {
    setLoading(true);
    setError(null);
    try {
      const res = await callToolRef.current("analyze_character_image", {
        project_slug: projectSlug,
        image_slug: imageSlug,
      });
      if (res.isError) {
        const content = res.content as Array<{ type: string; text: string }> | undefined;
        const msg = content?.[0]?.text ?? "analyze_character_image failed";
        setError(msg);
        toast({ title: "Character analysis failed", description: msg, duration: 4000 });
        return null;
      }
      const content = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as { profile: LegacyCharacterProfile };
      return normalizeCharacterProfile(parsed.profile);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast({ title: "Character analysis failed", description: msg, duration: 4000 });
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { analyze, loading, error };
}
