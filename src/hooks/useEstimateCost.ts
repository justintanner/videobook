import { useCallback, useEffect, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";

export type CostSource =
  | "tokens-heuristic+table"
  | "per-unit-table"
  | "free";

export interface CostBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  units?: number;
  unit?: "tokens" | "characters" | "seconds" | "images" | "songs";
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  perUnitUsd?: number;
}

export interface CostEstimate {
  usd: number;
  currency: "USD";
  source: CostSource;
  breakdown: CostBreakdown;
  rateAsOf: string | null;
  warnings: string[];
}

export interface EstimateCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface UseEstimateCostOptions {
  calls: EstimateCall[] | null;
  enabled?: boolean;
}

export interface UseEstimateCostResult {
  estimate: CostEstimate | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  refresh: () => void;
}

function callsKey(calls: EstimateCall[]): string {
  return JSON.stringify(calls);
}

const DEBOUNCE_MS = 300;

export function useEstimateCost(
  callTool: UseMcpResult["callTool"],
  { calls, enabled = true }: UseEstimateCostOptions,
): UseEstimateCostResult {
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const computedKeyRef = useRef<string | null>(null);
  const pendingKeyRef = useRef<string | null>(null);
  const callsRef = useRef<EstimateCall[] | null>(calls);
  callsRef.current = calls;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const fetchEstimate = useCallback(async () => {
    const current = callsRef.current;
    if (!current || current.length === 0) return;
    const requestKey = callsKey(current);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    pendingKeyRef.current = requestKey;
    setLoading(true);
    setError(null);
    try {
      const result = await callToolRef.current("estimate_cost", {
        calls: current.map((c) => ({ tool_name: c.toolName, input: c.input })),
      });
      if (ac.signal.aborted) return;
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        setError(content?.[0]?.text ?? "estimate_cost failed");
        setEstimate(null);
        pendingKeyRef.current = null;
      } else {
        const content = result.content as Array<{ type: string; text: string }>;
        const parsed = JSON.parse(content[0].text) as { estimate: CostEstimate };
        setEstimate(parsed.estimate);
        computedKeyRef.current = requestKey;
        pendingKeyRef.current = null;
        setStale(false);
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      pendingKeyRef.current = null;
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  const scheduleFetch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      if (!enabledRef.current) return;
      void fetchEstimate();
    }, DEBOUNCE_MS);
  }, [fetchEstimate]);

  // First compute fires immediately; subsequent input changes debounce-refetch.
  useEffect(() => {
    if (!enabled) return;
    if (!calls || calls.length === 0) return;
    const nextKey = callsKey(calls);
    if (computedKeyRef.current === nextKey) return;
    if (pendingKeyRef.current === nextKey) return;
    if (computedKeyRef.current === null) {
      pendingKeyRef.current = nextKey;
      void fetchEstimate();
    } else {
      setStale(true);
      pendingKeyRef.current = nextKey;
      scheduleFetch();
    }
  }, [enabled, calls, fetchEstimate, scheduleFetch]);

  // Cancel in-flight request and pending debounce on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const refresh = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void fetchEstimate();
  }, [fetchEstimate]);

  return { estimate, loading, error, stale, refresh };
}
