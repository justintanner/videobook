import { useCallback, useEffect, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";

export type CostSource =
  | "upstream-usd"
  | "tokens-api+table"
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
  const computedKeyRef = useRef<string | null>(null);
  const callsRef = useRef<EstimateCall[] | null>(calls);
  callsRef.current = calls;

  const fetchEstimate = useCallback(async () => {
    const current = callsRef.current;
    if (!current || current.length === 0) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
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
      } else {
        const content = result.content as Array<{ type: string; text: string }>;
        const parsed = JSON.parse(content[0].text) as { estimate: CostEstimate };
        setEstimate(parsed.estimate);
        computedKeyRef.current = callsKey(current);
        setStale(false);
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  // Initial compute when enabled with calls — caller gates on connection state.
  useEffect(() => {
    if (!enabled) return;
    if (!calls || calls.length === 0) return;
    if (computedKeyRef.current !== null) return;
    void fetchEstimate();
  }, [enabled, calls, fetchEstimate]);

  // Mark estimate stale when inputs change after first compute.
  useEffect(() => {
    if (!calls || calls.length === 0) return;
    if (computedKeyRef.current === null) return;
    const nextKey = callsKey(calls);
    if (nextKey !== computedKeyRef.current) setStale(true);
  }, [calls]);

  // Cancel in-flight request on unmount.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const refresh = useCallback(() => {
    void fetchEstimate();
  }, [fetchEstimate]);

  return { estimate, loading, error, stale, refresh };
}
