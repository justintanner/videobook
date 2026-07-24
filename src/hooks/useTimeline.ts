import { useState, useCallback, useRef, useEffect } from "react";
import type { UseMcpResult } from "use-mcp/react";

export type Orientation = 'landscape' | 'portrait' | 'square';
type ViewerSize = 'landscape' | 'portrait' | 'square' | 'original';

export interface TimelineAudioClip {
  id: string;
  slug: string;
  startFrame: number;
  durationFrames: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface TimelineConfig {
  slots: Array<{ slug: string; volume?: number; audioFadeIn?: number; audioFadeOut?: number }>;
  audio?: TimelineAudioClip[];
  render: Orientation;
  currentOrientation?: ViewerSize;
}

interface UseTimelineResult {
  timeline: TimelineConfig | undefined;
  fetchTimeline: (bookId: string) => Promise<TimelineConfig | null>;
  setRenderOrientation: (bookId: string, orient: Orientation) => Promise<boolean>;
  setCurrentOrientation: (bookId: string, orient: ViewerSize) => void;
  assignSlot: (bookId: string, assetId: string, slotIndex: number) => Promise<boolean>;
  clearSlot: (bookId: string, slotIndex: number) => Promise<boolean>;
  addAudio: (bookId: string, assetId: string, startFrame: number, durationFrames?: number) => Promise<boolean>;
  moveAudio: (bookId: string, audioId: string, startFrame: number) => Promise<boolean>;
  removeAudio: (bookId: string, audioId: string) => Promise<boolean>;
  updateAudio: (
    bookId: string,
    audioId: string,
    fields: { volume?: number; fadeIn?: number; fadeOut?: number },
  ) => Promise<boolean>;
}

export function useTimeline(callTool: UseMcpResult["callTool"]): UseTimelineResult {
  const [timeline, setTimeline] = useState<TimelineConfig | undefined>();
  const callToolRef = useRef(callTool);
  useEffect(() => { callToolRef.current = callTool; }, [callTool]);

  const fetchTimeline = useCallback(async (bookId: string): Promise<TimelineConfig | null> => {
    try {
      const result = await callToolRef.current("get_timeline", { book_id: bookId });
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

  const setRenderOrientation = useCallback(async (bookId: string, orient: Orientation): Promise<boolean> => {
    try {
      const getResult = await callToolRef.current("get_timeline", { book_id: bookId });
      if (getResult.isError) return false;
      const content = getResult.content as Array<{ type: string; text: string }>;
      const current: TimelineConfig = JSON.parse(content[0].text);

      const updatedConfig = { ...current, render: orient };

      const editResult = await callToolRef.current("set_timeline", {
        book_id: bookId,
        slots: updatedConfig.slots,
        render: orient,
        ...(current.audio !== undefined && { audio: current.audio }),
        ...(current.currentOrientation !== undefined && { currentOrientation: current.currentOrientation }),
      });
      if (editResult.isError) return false;

      setTimeline(updatedConfig);
      return true;
    } catch (e: unknown) {
      console.error("[edit_timeline] exception:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  const setCurrentOrientation = useCallback((bookId: string, orient: ViewerSize) => {
    callToolRef.current("get_timeline", { book_id: bookId }).then(async getResult => {
      if (getResult.isError) return;
      const content = getResult.content as Array<{ type: string; text: string }>;
      const current: TimelineConfig = JSON.parse(content[0].text);
      const updated = { ...current, currentOrientation: orient };
      const editResult = await callToolRef.current("set_timeline", {
        book_id: bookId,
        slots: updated.slots,
        render: updated.render,
        ...(current.audio !== undefined && { audio: current.audio }),
        currentOrientation: orient,
      });
      if (editResult.isError) return;
      setTimeline(updated);
    }).catch(() => {});
  }, []);

  const assignSlot = useCallback(async (bookId: string, assetId: string, slotIndex: number): Promise<boolean> => {
    try {
      const slot = `s${String(slotIndex + 1).padStart(2, '0')}`;
      const result = await callToolRef.current("assign_slot", {
        book_id: bookId,
        asset_id: assetId,
        slot,
      });
      if (result.isError) return false;
      // Re-fetch to sync local state
      await fetchTimeline(bookId);
      return true;
    } catch (e: unknown) {
      console.error("[assign_slot] exception:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [fetchTimeline]);

  const clearSlot = useCallback(async (bookId: string, slotIndex: number): Promise<boolean> => {
    try {
      const slot = `s${String(slotIndex + 1).padStart(2, '0')}`;
      const result = await callToolRef.current("unassign_slot", {
        book_id: bookId,
        slot,
      });
      if (result.isError) return false;
      await fetchTimeline(bookId);
      return true;
    } catch (e: unknown) {
      console.error("[unassign_slot] exception:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [fetchTimeline]);

  const addAudio = useCallback(async (bookId: string, assetId: string, startFrame: number, durationFrames?: number): Promise<boolean> => {
    try {
      const args: Record<string, unknown> = {
        book_id: bookId,
        asset_id: assetId,
        start_frame: startFrame,
      };
      if (typeof durationFrames === "number" && durationFrames > 0) {
        args.duration_frames = durationFrames;
      }
      const result = await callToolRef.current("add_timeline_audio", args);
      if (result.isError) return false;
      await fetchTimeline(bookId);
      return true;
    } catch (e: unknown) {
      console.error("[add_timeline_audio] exception:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [fetchTimeline]);

  const moveAudio = useCallback(async (bookId: string, audioId: string, startFrame: number): Promise<boolean> => {
    try {
      const result = await callToolRef.current("move_timeline_audio", {
        book_id: bookId,
        audio_id: audioId,
        start_frame: startFrame,
      });
      if (result.isError) return false;
      await fetchTimeline(bookId);
      return true;
    } catch (e: unknown) {
      console.error("[move_timeline_audio] exception:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [fetchTimeline]);

  const removeAudio = useCallback(async (bookId: string, audioId: string): Promise<boolean> => {
    try {
      const result = await callToolRef.current("remove_timeline_audio", {
        book_id: bookId,
        audio_id: audioId,
      });
      if (result.isError) return false;
      await fetchTimeline(bookId);
      return true;
    } catch (e: unknown) {
      console.error("[remove_timeline_audio] exception:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [fetchTimeline]);

  const updateAudio = useCallback(async (
    bookId: string,
    audioId: string,
    fields: { volume?: number; fadeIn?: number; fadeOut?: number },
  ): Promise<boolean> => {
    try {
      const args: Record<string, unknown> = {
        book_id: bookId,
        audio_id: audioId,
      };
      if (fields.volume !== undefined) args.volume = fields.volume;
      if (fields.fadeIn !== undefined) args.fade_in = fields.fadeIn;
      if (fields.fadeOut !== undefined) args.fade_out = fields.fadeOut;
      const result = await callToolRef.current("update_timeline_audio", args);
      if (result.isError) return false;
      await fetchTimeline(bookId);
      return true;
    } catch (e: unknown) {
      console.error("[update_timeline_audio] exception:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [fetchTimeline]);

  return { timeline, fetchTimeline, setRenderOrientation, setCurrentOrientation, assignSlot, clearSlot, addAudio, moveAudio, removeAudio, updateAudio };
}
