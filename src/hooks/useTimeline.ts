import { useState, useCallback, useRef, useEffect } from "react";
import type { UseMcpResult } from "use-mcp/react";

export type Orientation = 'landscape' | 'portrait' | 'square';
export type ViewerSize = 'landscape' | 'portrait' | 'square' | 'original';

export interface TimelineConfig {
  slots: Array<{ slug: string; volume?: number; audioFadeIn?: number; audioFadeOut?: number }>;
  render: Orientation[];
  currentOrientation?: ViewerSize;
}

interface UseTimelineResult {
  timeline: TimelineConfig | undefined;
  fetchTimeline: (projectSlug: string) => Promise<TimelineConfig | null>;
  addOrientation: (projectSlug: string, orient: Orientation) => Promise<boolean>;
  setCurrentOrientation: (projectSlug: string, orient: ViewerSize) => void;
}

export function useTimeline(callTool: UseMcpResult["callTool"]): UseTimelineResult {
  const [timeline, setTimeline] = useState<TimelineConfig | undefined>();
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  const fetchTimeline = useCallback(async (projectSlug: string): Promise<TimelineConfig | null> => {
    try {
      const result = await callToolRef.current("get_timeline", { project_slug: projectSlug });
      if (result.isError) return null;
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed: TimelineConfig = JSON.parse(content[0].text);
      setTimeline(parsed);
      return parsed;
    } catch (e: unknown) {
      console.error("[get_timeline] exception:", e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  const addOrientation = useCallback(async (projectSlug: string, orient: Orientation): Promise<boolean> => {
    try {
      // Read current config first
      const getResult = await callToolRef.current("get_timeline", { project_slug: projectSlug });
      if (getResult.isError) return false;
      const content = getResult.content as Array<{ type: string; text: string }>;
      const current: TimelineConfig = JSON.parse(content[0].text);

      // Append new orientation
      const updatedRender = [...current.render, orient];
      const updatedConfig = { ...current, render: updatedRender };

      const editResult = await callToolRef.current("edit_timeline", {
        project_slug: projectSlug,
        slots: updatedConfig.slots,
        render: updatedConfig.render,
      });
      if (editResult.isError) return false;

      setTimeline(updatedConfig);
      return true;
    } catch (e: unknown) {
      console.error("[edit_timeline] exception:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  const setCurrentOrientation = useCallback((projectSlug: string, orient: ViewerSize) => {
    callToolRef.current("get_timeline", { project_slug: projectSlug }).then(getResult => {
      if (getResult.isError) return;
      const content = getResult.content as Array<{ type: string; text: string }>;
      const current: TimelineConfig = JSON.parse(content[0].text);
      const updated = { ...current, currentOrientation: orient };
      callToolRef.current("edit_timeline", {
        project_slug: projectSlug,
        slots: updated.slots,
        render: updated.render,
        currentOrientation: orient,
      });
      setTimeline(updated);
    }).catch(() => {});
  }, []);

  return { timeline, fetchTimeline, addOrientation, setCurrentOrientation };
}
