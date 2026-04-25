import { useCallback, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";
import type { CharacterProfile } from "@/hooks/useCharacterSlots";
import type { OutfitModelKey, OutfitProvider } from "@/hooks/useGenerateOutfit";
import { toast } from "@/hooks/useToast";

export interface CharacterOutcome {
  model: OutfitModelKey;
  provider: OutfitProvider;
  prompt: string;
  char_asset_id?: string;
  job_id?: string;
  error?: string;
}

export interface GenerateCharacterArgs {
  projectSlug: string;
  sourceImageSlug: string;
  profile: CharacterProfile;
  models: OutfitModelKey[];
  provider: OutfitProvider;
  outfitText?: string;
  outfitImageSlug?: string;
}

export interface GenerateCharacterResult {
  status: "enqueued" | "failed";
  enqueued: number;
  failed: number;
  outcomes: CharacterOutcome[];
}

export interface UseGenerateCharacterResult {
  generate: (args: GenerateCharacterArgs) => Promise<GenerateCharacterResult | null>;
  submitting: boolean;
}

export function useGenerateCharacter(callTool: UseMcpResult["callTool"]): UseGenerateCharacterResult {
  const [submitting, setSubmitting] = useState(false);
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;
  const inFlightRef = useRef(false);

  const generate = useCallback(async (args: GenerateCharacterArgs): Promise<GenerateCharacterResult | null> => {
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const res = await callToolRef.current("generate_character", {
        project_slug: args.projectSlug,
        source_image_slug: args.sourceImageSlug,
        profile: args.profile,
        models: args.models,
        provider: args.provider,
        ...(args.outfitText?.trim() ? { outfit_text: args.outfitText.trim() } : {}),
        ...(args.outfitImageSlug ? { outfit_image_slug: args.outfitImageSlug } : {}),
      });
      if (res.isError) {
        const content = res.content as Array<{ type: string; text: string }> | undefined;
        const msg = content?.[0]?.text ?? "generate_character failed";
        toast({ title: "Generate character failed", description: msg, duration: 4000 });
        return null;
      }
      const content = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text) as GenerateCharacterResult;
      const providerLabel = args.provider === "kie" ? "Kie" : "Fal";
      toast({
        title: "Character generating",
        description: `${parsed.enqueued} sheet${parsed.enqueued === 1 ? "" : "s"} queued via ${providerLabel}`,
        duration: 3000,
      });
      await callToolRef.current("sync", { project_slug: args.projectSlug });
      return parsed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Generate character failed", description: msg, duration: 4000 });
      return null;
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, []);

  return { generate, submitting };
}
