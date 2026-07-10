import { useState, useCallback, useRef } from "react";
import type { UseMcpResult } from "use-mcp/react";
import { toast } from "@/hooks/useToast";
import type { RewritePlatform } from "@/hooks/useRewriteScript";

export type ImagePromptGuideModel =
  | "nano_banana"
  | "gpt_image"
  | "kling30"
  | "grok_imagine"
  | "grok_image"
  | "gemini_omni";

export interface RewriteImagePromptArgs {
  prompt: string;
  model: ImagePromptGuideModel;
  imageSlugs?: string[];
  platform?: RewritePlatform;
  customPrompt?: string;
  /** Rewrite against the useapi.net provider docs instead of a platform aesthetic. */
  providerDocs?: boolean;
  projectSlug: string;
}

export interface UseRewriteImagePromptResult {
  rewrite: (args: RewriteImagePromptArgs) => Promise<string | null>;
  rewriting: boolean;
  error: string | undefined;
}

interface ToolArgs {
  prompt?: string;
  model: ImagePromptGuideModel;
  image_slugs?: string[];
  project_slug: string;
  platform?: RewritePlatform;
  custom_prompt?: string;
  provider_docs?: boolean;
}

interface RewritePromptToolResult {
  rewritten_prompt?: string;
  previous_error?: { message: string; fail_code?: string };
}

export function useRewriteImagePrompt(callTool: UseMcpResult["callTool"]): UseRewriteImagePromptResult {
  const [rewriting, setRewriting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;
  const inFlightRef = useRef(false);

  const rewrite = useCallback(async (args: RewriteImagePromptArgs): Promise<string | null> => {
    if (inFlightRef.current) return null;

    const trimmedPrompt = args.prompt.trim();
    const slugs = args.imageSlugs ?? [];
    if (!trimmedPrompt && slugs.length === 0) {
      const msg = "Provide a prompt or at least one reference image";
      setError(msg);
      toast({ title: "Nothing to rewrite", description: msg, duration: 3000 });
      return null;
    }

    inFlightRef.current = true;
    setRewriting(true);
    setError(undefined);

    try {
      const toolArgs: ToolArgs = {
        model: args.model,
        project_slug: args.projectSlug,
      };
      if (trimmedPrompt) toolArgs.prompt = trimmedPrompt;
      if (slugs.length > 0) toolArgs.image_slugs = slugs;
      if (args.providerDocs) toolArgs.provider_docs = true;
      else if (args.platform) toolArgs.platform = args.platform;
      if (args.customPrompt && args.customPrompt.trim().length > 0) {
        toolArgs.custom_prompt = args.customPrompt.trim();
      }

      const result = await callToolRef.current(
        "rewrite_prompt",
        toolArgs as unknown as Record<string, unknown>,
      );

      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        const msg = content?.[0]?.text ?? "Rewrite failed";
        setError(msg);
        toast({ title: "Rewrite failed", description: msg, duration: 4000 });
        return null;
      }

      const content = result.content as Array<{ type: string; text: string }> | undefined;
      const text = content?.[0]?.text;
      if (!text) {
        const msg = "Empty response from rewrite_prompt";
        setError(msg);
        toast({ title: "Rewrite failed", description: msg, duration: 4000 });
        return null;
      }

      const parsed = JSON.parse(text) as RewritePromptToolResult;
      const rewritten = parsed.rewritten_prompt?.trim();
      if (!rewritten) {
        const msg = "No rewritten_prompt in response";
        setError(msg);
        toast({ title: "Rewrite failed", description: msg, duration: 4000 });
        return null;
      }
      if (parsed.previous_error) {
        const detail = parsed.previous_error.fail_code ?? parsed.previous_error.message;
        toast({ title: "Adapted around previous failure", description: detail, duration: 4000 });
      }
      return rewritten;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast({ title: "Rewrite failed", description: msg, duration: 4000 });
      return null;
    } finally {
      inFlightRef.current = false;
      setRewriting(false);
    }
  }, []);

  return { rewrite, rewriting, error };
}
