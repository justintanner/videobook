import sharp from "sharp";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { firstEmptyNotebookGridSlots, notebookOccupiedSlots, NOTEBOOK_GRID_CAPACITY } from "videobook-engine/notebook-grid";
import {
  formatShortSeconds, SHORT_STORYBOARD_ASPECT_RATIOS, SHORT_STORYBOARD_MODELS,
  type ShortStoryboard, type ShortStoryboardAspectRatio, type ShortStoryboardVideo,
} from "./goal-short-plan.js";
import { EXTRACT_FRAME_OUTPUT_ROLE } from "./notebook-cell-outputs.js";
import { existingFrameCell, readableImage, type UsableImage } from "./notebook-frame-cells.js";
import { arrangeGoalNotebook } from "./notebook-goal-layout.js";
import { captureFrame } from "./notebook-media-ops.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { selectSceneCuts } from "./scene-cuts.js";
import { awaitScenes } from "./tools/detect-scenes.js";

const STORYBOARD_COUNT = 4;
const EDGE_GUARD_SECONDS = 0.25;
const MIN_PART_SECONDS = 1;
const CLEANUP_PROMPT = [
  "Remove every on-screen graphic that was added on top of the camera picture: captions, titles and any other overlaid text, stickers and their underlines, emoji, platform logos and watermarks, creator credits and usernames with their icons, progress bars, borders, black or blurred bars, and darkening shade gradients.",
  "Fill each of those areas with what the camera saw there, so the scene continues naturally behind them.",
  "Change nothing else: keep the people, animals and objects exactly as they are, with any printing that is physically on them (a logo printed on an umbrella stays), and keep the place, light, colour, framing and size.",
  "Do not crop, zoom or add anything new.",
].join(" ");

type Span = { start: number; end: number };

export type StoryboardVideo = { artifactId: string; cellId?: string };

export type StoryboardFrame = UsableImage & {
  index: number;
  atSeconds: number;
  requestedSeconds: number;
  aspectRatio: ShortStoryboardAspectRatio;
};

type CapturedFrame = { artifactId: string; atSeconds: number; label: string };

function spanSeconds(span: Span): number {
  return span.end - span.start;
}

function momentIn(span: Span): number {
  const middle = Math.round((span.start + span.end) * 50) / 100;
  return Math.min(Math.max(middle, span.start + EDGE_GUARD_SECONDS), span.end - EDGE_GUARD_SECONDS);
}

function equalPartMoments(window: Span, count: number): number[] {
  const parts = Math.min(count, Math.max(1, Math.floor(spanSeconds(window) / MIN_PART_SECONDS)));
  const part = spanSeconds(window) / parts;
  return Array.from({ length: parts }, (_, index) => momentIn({ start: window.start + index * part, end: window.start + (index + 1) * part }));
}

function shotsBetween(window: Span, cuts: readonly number[]): Span[] {
  const bounds = [window.start, ...cuts, window.end];
  return bounds.slice(1).map((end, index) => ({ start: bounds[index]!, end }));
}

function groupSeconds(group: readonly Span[]): number {
  return group.reduce((sum, shot) => sum + spanSeconds(shot), 0);
}

function mergeShortestGroups(groups: Span[][], count: number): Span[][] {
  const merged = [...groups];
  while (merged.length > count) {
    const shortest = merged.reduce((best, group, index) => groupSeconds(group) < groupSeconds(merged[best]!) ? index : best, 0);
    const before = merged[shortest - 1];
    const after = merged[shortest + 1];
    const first = !after || (before && groupSeconds(before) <= groupSeconds(after)) ? shortest - 1 : shortest;
    merged.splice(first, 2, [...merged[first]!, ...merged[first + 1]!]);
  }
  return merged;
}

function longestShot(group: readonly Span[]): Span {
  return group.reduce((best, shot) => spanSeconds(shot) > spanSeconds(best) ? shot : best);
}

export function storyboardMoments(input: { durationSeconds: number; cutSeconds: readonly number[]; count?: number; fromSeconds?: number }): number[] {
  const count = Math.floor(input.count ?? STORYBOARD_COUNT);
  const from = Number.isFinite(input.fromSeconds) ? Math.max(0, input.fromSeconds!) : 0;
  const window = { start: from, end: input.durationSeconds };
  if (!(count >= 1) || !Number.isFinite(window.end) || spanSeconds(window) < 2 * EDGE_GUARD_SECONDS) return [];
  const cuts = [...new Set(input.cutSeconds)].filter((cut) => cut > window.start && cut < window.end).sort((left, right) => left - right);
  if (cuts.length === 0) return equalPartMoments(window, count);
  const shots = shotsBetween(window, cuts).filter((shot) => spanSeconds(shot) >= 2 * EDGE_GUARD_SECONDS);
  return mergeShortestGroups(shots.map((shot) => [shot]), count).map((group) => momentIn(longestShot(group)));
}

export async function videoStoryboardMoments(engine: Engine, bookId: string, artifactId: string, options: { count?: number; fromSeconds?: number } = {}): Promise<number[]> {
  const scenes = await awaitScenes(engine, artifactId, bookId);
  return storyboardMoments({ durationSeconds: scenes.durationSeconds, cutSeconds: selectSceneCuts(scenes), ...options });
}

function readNotebook(engine: Engine, notebookId: string): NotebookDocument {
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return notebook.value;
}

function storyboardLabel(index: number, total: number, seconds: number): string {
  return `Storyboard ${index + 1} of ${total} · ${formatShortSeconds(seconds)} s`;
}

function ratioValue(ratio: ShortStoryboardAspectRatio): number {
  const [width, height] = ratio.split(":").map(Number);
  return width! / height!;
}

function nearestAspectRatio(width: number, height: number): ShortStoryboardAspectRatio {
  const target = Math.log(width / height);
  const distance = (ratio: ShortStoryboardAspectRatio) => Math.abs(Math.log(ratioValue(ratio)) - target);
  return SHORT_STORYBOARD_ASPECT_RATIOS.reduce((best, ratio) => distance(ratio) < distance(best) ? ratio : best);
}

async function frameAspectRatio(engine: Engine, artifactId: string): Promise<ShortStoryboardAspectRatio> {
  const manifest = await engine.files.manifest(artifactId);
  const file = manifest.ok ? findPrimaryMediaFile(manifest.value.files, "image") : null;
  const bytes = file ? await engine.files.read(artifactId, file.name) : null;
  if (!bytes?.ok) throw new Error("A storyboard frame has no readable image.");
  const { width, height } = await sharp(bytes.value).metadata();
  if (!width || !height) throw new Error("A storyboard frame has no readable size.");
  return nearestAspectRatio(width, height);
}

async function captureMissingFrames(engine: Engine, video: StoryboardVideo, moments: readonly number[], existing: readonly (NotebookCell | null)[]): Promise<(CapturedFrame | null)[]> {
  const captured: (CapturedFrame | null)[] = [];
  for (const [index, seconds] of moments.entries()) {
    if (existing[index]) {
      captured.push(null);
      continue;
    }
    const label = storyboardLabel(index, moments.length, seconds);
    const frame = await captureFrame(engine, video.artifactId, { role: "time", timestampSeconds: seconds, title: label });
    captured.push({ ...frame, label });
  }
  return captured;
}

async function placeCapturedFrames(engine: Engine, notebookId: string, video: StoryboardVideo, moments: readonly number[], captured: readonly (CapturedFrame | null)[]): Promise<Map<number, string>> {
  const placed = new Map<number, string>();
  const missing = captured.flatMap((frame, index) => frame ? [{ frame, index }] : []);
  if (missing.length === 0) return placed;
  const result = await mutateNotebook(engine, notebookId, "goal_storyboard_frames", (document) => {
    const cells = [...document.cells];
    const slots = firstEmptyNotebookGridSlots(notebookOccupiedSlots(cells), missing.length);
    for (const [position, { frame, index }] of missing.entries()) {
      const cell = engine.notebooks.createCell({
        type: "image",
        label: frame.label,
        slot: slots[position]!,
        outputArtifactId: frame.artifactId,
        inputs: {
          mediaRole: EXTRACT_FRAME_OUTPUT_ROLE,
          sourceArtifactId: video.artifactId,
          ...(video.cellId ? { sourceCellId: video.cellId } : {}),
          frameMode: "time",
          atSeconds: frame.atSeconds,
          requestedSeconds: moments[index]!,
          storyboardIndex: index,
          state: "completed",
        },
      });
      placed.set(index, cell.id);
      cells.push(cell);
    }
    return arrangeGoalNotebook({ ...document, cells });
  }, { artifactId: video.artifactId, frames: missing.length });
  if (!result.ok) throw new Error(result.error.message);
  return placed;
}

async function storyboardFrame(engine: Engine, document: NotebookDocument, cellId: string, index: number, requestedSeconds: number): Promise<StoryboardFrame> {
  const cell = document.cells.find((candidate) => candidate.id === cellId);
  const image = cell?.outputArtifactId ? await readableImage(engine, cell.outputArtifactId, cell) : null;
  if (!cell || !image) throw new Error(`Storyboard frame ${index + 1} has no readable image.`);
  const stamped = cell.inputs?.atSeconds;
  return {
    ...image,
    index,
    atSeconds: typeof stamped === "number" ? stamped : requestedSeconds,
    requestedSeconds,
    aspectRatio: await frameAspectRatio(engine, image.artifactId),
  };
}

export async function captureStoryboardFrames(engine: Engine, notebookId: string, video: StoryboardVideo, moments: readonly number[]): Promise<StoryboardFrame[]> {
  const before = readNotebook(engine, notebookId);
  const existing = await Promise.all(moments.map((seconds) => existingFrameCell(engine, before, video.artifactId, video.cellId, seconds)));
  const needed = existing.filter((cell) => !cell).length;
  if (NOTEBOOK_GRID_CAPACITY - notebookOccupiedSlots(before.cells).length < needed) {
    throw new Error(`The notebook needs ${needed} empty cells for the storyboard frames.`);
  }
  const captured = await captureMissingFrames(engine, video, moments, existing);
  const placed = await placeCapturedFrames(engine, notebookId, video, moments, captured);
  const document = readNotebook(engine, notebookId);
  return Promise.all(moments.map((seconds, index) => storyboardFrame(engine, document, existing[index]?.id ?? placed.get(index)!, index, seconds)));
}

export function shortStoryboard(video: ShortStoryboardVideo, frames: readonly StoryboardFrame[]): ShortStoryboard {
  return {
    video,
    model: SHORT_STORYBOARD_MODELS[0],
    frames: frames.map(({ requestedSeconds: _requested, ...frame }) => ({ ...frame, prompt: CLEANUP_PROMPT })),
  };
}
