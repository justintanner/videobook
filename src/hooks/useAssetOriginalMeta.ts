import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseMcpResult } from 'use-mcp/react';
import type { RewriteMeta, RewriteVariant, RewritePlatform } from './useAssetHistory';

interface OriginalJson {
  origin?: string;
  model?: string;
  variant?: RewriteVariant;
  platform?: RewritePlatform;
  customPrompt?: string;
  processed_at?: string;
}

function parseOriginalToRewrite(json: OriginalJson): RewriteMeta | null {
  if (json.origin !== 'describe_image') return null;
  return {
    model: json.model ?? 'gpt-5.2',
    variant: json.variant ?? 'full',
    ...(json.platform ? { platform: json.platform } : {}),
    ...(json.customPrompt ? { customPrompt: json.customPrompt } : {}),
    ...(json.processed_at ? { processedAt: json.processed_at } : {}),
  };
}

/**
 * Fetches native `original` metadata for the current revision.
 * Returns null when missing, unparseable, or origin !== describe_image.
 * Re-fetches on asset-id change; expose `refresh` for post-rewrite invalidation.
 */
export function useAssetOriginalMeta(
  callTool: UseMcpResult['callTool'],
  assetId: string | null,
  bookId: string,
): { meta: RewriteMeta | null; refresh: () => void } {
  const [meta, setMeta] = useState<RewriteMeta | null>(null);
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  const fetchMeta = useCallback(async () => {
    if (!assetId || !assetId.startsWith('script-')) {
      setMeta(null);
      return;
    }
    try {
      const result = await callToolRef.current('read_asset_metadata', {
        asset_id: assetId,
        name: 'original',
        book_id: bookId,
      });
      if (result.isError) {
        setMeta(null);
        return;
      }
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      if (!text) { setMeta(null); return; }
      const parsed = JSON.parse(text) as OriginalJson;
      setMeta(parseOriginalToRewrite(parsed));
    } catch {
      setMeta(null);
    }
  }, [assetId, bookId]);

  useEffect(() => {
    // setState runs inside fetchMeta after an async MCP round-trip — this is an
    // external-data subscription, not a derived-state cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchMeta();
  }, [fetchMeta]);

  return { meta, refresh: () => { void fetchMeta(); } };
}
