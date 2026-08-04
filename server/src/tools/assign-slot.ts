import type { Artifact, Engine } from "videobook-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import { enqueueLazyTimelineRender } from "../lazy-render.js";
import {
  readTimeline,
  resolveArtifact,
  slotIndex,
  timelineFailure,
  timelineInput,
  timelinePayload,
  type TimelineSlotInput,
  writeTimeline,
} from "../timeline-helpers.js";
import type { ToolDef } from "./tool-def.js";

async function enqueueLazyAnalysis(
  engine: Engine,
  asset: Artifact,
  bookId: string,
): Promise<{ jobId: string; kind: "analyze_video" | "describe_image" } | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  if (asset.kind !== "video" && asset.kind !== "image") return null;
  const manifest = await engine.files.manifest(asset.artifactId);
  if (!manifest.ok) return null;
  if ((await engine.files.read(asset.artifactId, ".original.analysis.json")).ok) return null;
  if (asset.kind === "video") {
    const transcription = await engine.files.read(
      asset.artifactId,
      ".analysis.gpt4otrans.json",
    );
    const jobId = `auto-analyze-${asset.slug}`;
    await queue.enqueue(jobId, {
      type: "analyze_video",
      bookId,
      assetId: asset.slug,
      assetDir: manifest.value.path,
      hasTranscription: transcription.ok,
    });
    return { jobId, kind: "analyze_video" };
  }
  const original = manifest.value.files.find((file) => /^original\.(jpe?g|png|webp)$/i.test(file.name));
  if (!original) return null;
  const jobId = `auto-describe-${asset.slug}`;
  await queue.enqueue(jobId, {
    type: "describe_image",
    bookId,
    sourceAssetId: asset.slug,
    sourceImageFilename: original.name,
  });
  return { jobId, kind: "describe_image" };
}

export function assignSlotDef(engine: Engine): ToolDef {
  return {
    name: "assign_slot",
    description: "Assign an artifact to a typed timeline slot",
    schema: {
      book_id: z.string().uuid(),
      asset_id: z.string(),
      slot: z.string(),
    },
    handler: async (args) => {
      const index = slotIndex(String(args.slot));
      if (index === null) return timelineFailure("Slot must use the form s01, s02, and so on");
      const asset = resolveArtifact(engine, String(args.asset_id));
      if (!asset) return timelineFailure(`Artifact not found: ${String(args.asset_id)}`);
      const timeline = readTimeline(engine);
      if (index > timeline.slots.length) {
        return timelineFailure("Typed timelines cannot contain empty gaps; assign the next available slot first");
      }
      const slots: TimelineSlotInput[] = timeline.slots.map((slot) => ({
        id: slot.id,
        artifactId: slot.artifactId,
        ...(slot.volume === undefined ? {} : { volume: slot.volume }),
        ...(slot.audioFadeIn === undefined ? {} : { audioFadeIn: slot.audioFadeIn }),
        ...(slot.audioFadeOut === undefined ? {} : { audioFadeOut: slot.audioFadeOut }),
      }));
      const replacement: TimelineSlotInput = index < slots.length
        ? { ...slots[index]!, artifactId: asset.artifactId }
        : { artifactId: asset.artifactId };
      if (index < slots.length) slots[index] = replacement;
      else slots.push(replacement);
      const result = await writeTimeline(engine, { ...timelineInput(timeline), slots });
      if (!result.ok) return timelineFailure(result.error.message);
      const response: Record<string, unknown> = timelinePayload(result.value);
      const bookId = String(args.book_id);
      try {
        const analysis = await enqueueLazyAnalysis(engine, asset, bookId);
        if (analysis) response.auto_analyze = analysis;
      } catch {
        delete response.auto_analyze;
      }
      try {
        const render = await enqueueLazyTimelineRender(engine, bookId, asset.slug, asset);
        if (render) response.auto_render = render;
      } catch {
        delete response.auto_render;
      }
      return { content: [{ type: "text", text: JSON.stringify(response) }] };
    },
  };
}
