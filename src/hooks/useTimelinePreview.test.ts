import { describe, it, expect } from "vitest";
import { computeTimelinePreview } from "./useTimelinePreview";
import type { TimelineConfig } from "@/hooks/useTimeline";
import type { MediaItem } from "@/components/sidebar/types";

const FPS = 30;

function videoItem(id: string, durationSeconds: number): MediaItem {
  return {
    id,
    type: "video",
    slug: id,
    title: id,
    filePath: `/files/proj/${id}/original.mp4`,
    renders: ["landscape"],
    duration: durationSeconds,
  };
}

const mediaItems: MediaItem[] = [
  videoItem("vid-a", 2),
  videoItem("vid-b", 4),
  videoItem("vid-c", 6),
];

describe("computeTimelinePreview", () => {
  it("emits one slot offset per timeline slot so display indices align", () => {
    const timeline: TimelineConfig = {
      slots: [
        { slug: "" },
        { slug: "vid-a" },
        { slug: "vid-b" },
        { slug: "" },
        { slug: "vid-c" },
      ],
      render: "landscape",
    };

    const preview = computeTimelinePreview(timeline, mediaItems, "proj", "landscape");

    expect(preview.slotOffsets).toEqual([0, 0, 2 * FPS, 6 * FPS, 6 * FPS]);
    expect(preview.emptySlots).toEqual([0, 3]);
    expect(preview.slots).toHaveLength(3);
    expect(preview.totalDurationInFrames).toBe(12 * FPS);
  });

  it("treats a slug with no matching media item as empty without advancing time", () => {
    const timeline: TimelineConfig = {
      slots: [{ slug: "vid-a" }, { slug: "vid-missing" }, { slug: "vid-b" }],
      render: "landscape",
    };

    const preview = computeTimelinePreview(timeline, mediaItems, "proj", "landscape");

    expect(preview.slotOffsets).toEqual([0, 2 * FPS, 2 * FPS]);
    expect(preview.emptySlots).toEqual([1]);
  });

  it("returns empty preview data without a timeline or project", () => {
    const preview = computeTimelinePreview(undefined, mediaItems, "proj", "landscape");

    expect(preview.ready).toBe(false);
    expect(preview.slotOffsets).toEqual([]);
  });
});
