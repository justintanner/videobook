import { useState, useCallback, useEffect, useRef } from "react";
import type { UseMcpResult } from "use-mcp/react";
import { toast } from "@/hooks/useToast";

export type RewritePlatform = "ig" | "tiktok" | "youtube";
export type RewriteVariant = "full" | "tldr";

export interface RewriteOptions {
  variant: RewriteVariant;
  platform?: RewritePlatform;
  customPrompt?: string;
}

export interface UseRewriteScriptResult {
  rewrite: (assetId: string, bookId: string, opts: RewriteOptions) => Promise<boolean>;
  rewriting: boolean;
  error: string | undefined;
}

interface ToolArgs {
  asset_id: string;
  variant: RewriteVariant;
  book_id: string;
  platform?: RewritePlatform;
  custom_prompt?: string;
}

function describe(variant: RewriteVariant, platform?: RewritePlatform): string {
  const base = variant === "tldr" ? "TLDR" : "Rewrite";
  if (!platform) return base;
  const label = platform === "ig" ? "IG" : platform === "tiktok" ? "TikTok" : "YouTube";
  return `${base} · ${label}`;
}

export function useRewriteScript(callTool: UseMcpResult["callTool"]): UseRewriteScriptResult {
  const [rewriting, setRewriting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const callToolRef = useRef(callTool);
  useEffect(() => {
    callToolRef.current = callTool;
  }, [callTool]);
  const inFlightRef = useRef(false);

  const rewrite = useCallback(async (assetId: string, bookId: string, opts: RewriteOptions): Promise<boolean> => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setRewriting(true);
    setError(undefined);
    try {
      const args: ToolArgs = {
        asset_id: assetId,
        variant: opts.variant,
        book_id: bookId,
      };
      if (opts.platform) args.platform = opts.platform;
      if (opts.customPrompt && opts.customPrompt.trim().length > 0) {
        args.custom_prompt = opts.customPrompt.trim();
      }

      const result = await callToolRef.current("rewrite_script", args as unknown as Record<string, unknown>);
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        const msg = content?.[0]?.text ?? "Rewrite failed";
        setError(msg);
        toast({ title: "Rewrite failed", description: msg, duration: 4000 });
        return false;
      }

      toast({
        title: `${describe(opts.variant, opts.platform)} queued`,
        description: assetId,
        duration: 2000,
      });
      await callToolRef.current("reconcile_project_work", { book_id: bookId });
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast({ title: "Rewrite failed", description: msg, duration: 4000 });
      return false;
    } finally {
      inFlightRef.current = false;
      setRewriting(false);
    }
  }, []);

  return { rewrite, rewriting, error };
}
