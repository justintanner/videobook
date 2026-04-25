import { useEffect, useRef, useState } from "react";
import type { UseMcpResult } from "use-mcp/react";

interface AnalysisJson {
  prompt?: string;
  shot?: string;
  pose?: string;
}

export interface UsePoseDescriptionArgs {
  callTool: UseMcpResult["callTool"];
  callState: UseMcpResult["state"];
  projectSlug: string | null | undefined;
  poseSlug: string | null | undefined;
}

export interface UsePoseDescriptionResult {
  poseDescription: string | null;
  shot: string | null;
  loading: boolean;
}

export function usePoseDescription({
  callTool,
  callState,
  projectSlug,
  poseSlug,
}: UsePoseDescriptionArgs): UsePoseDescriptionResult {
  const [poseDescription, setPoseDescription] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const callToolRef = useRef(callTool);
  callToolRef.current = callTool;
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!poseSlug || !projectSlug || callState !== "ready") {
      setPoseDescription(null);
      setShot(null);
      setLoading(false);
      return;
    }
    const reqId = ++requestIdRef.current;
    setLoading(true);
    callToolRef.current("read_asset_metadata", {
      asset_id: poseSlug,
      name: "original.analysis",
      project_slug: projectSlug,
    }).then(
      (result) => {
        if (reqId !== requestIdRef.current) return;
        if (result.isError) {
          setPoseDescription(null);
          setShot(null);
          setLoading(false);
          return;
        }
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        const text = content?.[0]?.text;
        if (!text) {
          setPoseDescription(null);
          setShot(null);
          setLoading(false);
          return;
        }
        try {
          const analysis = JSON.parse(text) as AnalysisJson;
          setPoseDescription(analysis.pose?.trim() || null);
          setShot(analysis.shot?.trim() || null);
        } catch {
          setPoseDescription(null);
          setShot(null);
        } finally {
          setLoading(false);
        }
      },
      () => {
        if (reqId !== requestIdRef.current) return;
        setPoseDescription(null);
        setShot(null);
        setLoading(false);
      },
    );
  }, [callState, projectSlug, poseSlug]);

  return { poseDescription, shot, loading };
}
