import { useCallback, useEffect, useRef } from "react";
import type { UseMcpResult } from "use-mcp/react";

export type GenerationError = {
  message: string;
  failedAt?: string;
  failCode?: string;
  prompt?: string;
};

export type GenerationPayloadResponse = {
  payload: unknown | null;
  meta: Record<string, unknown> | null;
  error: GenerationError | null;
  taskType: string | null;
};

export type GenerationPayloadResult =
  | { ok: true; data: GenerationPayloadResponse }
  | { ok: false; error: string };

export function useGenerationPayload(callTool: UseMcpResult["callTool"]) {
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  const cacheRef = useRef<Map<string, GenerationPayloadResult>>(new Map());

  const fetchPayload = useCallback(async (
    projectSlug: string,
    assetId: string,
  ): Promise<GenerationPayloadResult> => {
    const key = `${projectSlug}:${assetId}`;
    const cached = cacheRef.current.get(key);
    if (cached) return cached;

    try {
      const result = await callToolRef.current("generation_payload", {
        project_slug: projectSlug,
        asset_id: assetId,
      });
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }>;
        const message = content[0]?.text ?? "Unknown error";
        const out: GenerationPayloadResult = { ok: false, error: message };
        cacheRef.current.set(key, out);
        return out;
      }
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0].text) as GenerationPayloadResponse;
      const out: GenerationPayloadResult = { ok: true, data };
      cacheRef.current.set(key, out);
      return out;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  }, []);

  return { fetchPayload };
}
