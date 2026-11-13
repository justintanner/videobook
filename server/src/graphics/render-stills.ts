import { randomUUID } from "node:crypto";
import { copyFile, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import type { HeadlessBrowser } from "@remotion/renderer";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { withRemotionCancellation } from "../remotion-cancellation.js";
import { renderBrowserExecutable } from "../remotion/browser.js";
import type { GraphicsOverlayImage, GraphicsStillProps } from "../remotion/graphics/GraphicsOverlay.js";
import { getSharedBundleLocation } from "../remotion/shared-bundle.js";
import type { GraphicsDocument, GraphicsFrame } from "./model.js";
import type { GraphicsStillGroup } from "./stills.js";
import { graphicsStillGroups } from "./stills.js";

export type GraphicsStillImage = { path: string; width: number; height: number };
export type GraphicsTransitionFrames = { paths: string[]; start: number; end: number; fps: number };
export type RenderedGraphicsStill = GraphicsStillGroup & { path: string; transitions?: GraphicsTransitionFrames[] };

type GraphicsStillsInput = {
  document: GraphicsDocument;
  frame: GraphicsFrame;
  durationSeconds: number;
  fps?: number;
  images: Readonly<Record<string, GraphicsStillImage>>;
  outputDir: string;
  signal: AbortSignal;
};

const COMPOSITION_ID = "graphics-still";
const SELECT_TIMEOUT_MS = 60_000;

function drawnImageIds(document: GraphicsDocument, groups: readonly GraphicsStillGroup[]): string[] {
  const drawn = new Set(groups.flatMap((group) => group.layerIds));
  return [...new Set(document.layers.flatMap((layer) => (layer.kind === "image" && drawn.has(layer.id) ? [layer.artifactId] : [])))];
}

export async function stageImages(
  bundleDir: string,
  ids: readonly string[],
  images: Readonly<Record<string, GraphicsStillImage>>,
  staged: string[],
): Promise<Record<string, GraphicsOverlayImage>> {
  const props: Record<string, GraphicsOverlayImage> = {};
  for (const id of ids) {
    const image = images[id];
    if (!image) continue;
    const name = `graphics-image-${randomUUID()}${extname(image.path) || ".png"}`;
    staged.push(join(bundleDir, name));
    await copyFile(image.path, join(bundleDir, name));
    props[id] = { src: name, width: image.width, height: image.height };
  }
  return props;
}

async function openStillBrowser(): Promise<HeadlessBrowser> {
  const browserExecutable = await renderBrowserExecutable();
  return openBrowser("chrome", { chromeMode: "headless-shell", ...(browserExecutable ? { browserExecutable } : {}) });
}

async function drawStill(
  input: GraphicsStillsInput,
  props: GraphicsStillProps,
  composition: Awaited<ReturnType<typeof selectComposition>>,
  bundleDir: string,
  browser: HeadlessBrowser,
  output: string,
): Promise<void> {
  input.signal.throwIfAborted();
  await withRemotionCancellation(input.signal, (cancelSignal) => renderStill({
    composition: { ...composition, props },
    serveUrl: bundleDir,
    output,
    overwrite: true,
    imageFormat: "png",
    inputProps: props,
    puppeteerInstance: browser,
    cancelSignal,
  }));
}

async function renderTransitions(
  input: GraphicsStillsInput,
  group: GraphicsStillGroup,
  index: number,
  props: GraphicsStillProps,
  composition: Awaited<ReturnType<typeof selectComposition>>,
  bundleDir: string,
  browser: HeadlessBrowser,
): Promise<GraphicsTransitionFrames[]> {
  if (group.timing.enter === "fade" && group.timing.exit === "fade") return [];
  const fps = input.fps && Number.isFinite(input.fps) && input.fps > 0 ? input.fps : 30;
  const windows = [
    { start: group.timing.start, end: Math.min(group.timing.start + group.timing.fadeIn, group.timing.end - group.timing.fadeOut) },
    { start: group.timing.end - group.timing.fadeOut, end: group.timing.end },
  ];
  const transitions: GraphicsTransitionFrames[] = [];
  for (const [edge, window] of windows.entries()) {
    const first = Math.ceil(window.start * fps - 1e-7);
    const last = Math.ceil(window.end * fps - 1e-7);
    if (last <= first) continue;
    const paths: string[] = [];
    for (let frame = first; frame < last; frame += 1) {
      const output = join(input.outputDir, `graphics-${index + 1}-${edge}-${String(frame - first).padStart(6, "0")}.png`);
      await drawStill(input, { ...props, seconds: frame / fps }, composition, bundleDir, browser, output);
      paths.push(output);
    }
    transitions.push({ paths, start: first / fps, end: last / fps, fps });
  }
  return transitions;
}

async function renderGroups(
  input: GraphicsStillsInput,
  groups: readonly GraphicsStillGroup[],
  bundleDir: string,
  images: Record<string, GraphicsOverlayImage>,
  browser: HeadlessBrowser,
): Promise<RenderedGraphicsStill[]> {
  const props = (groupIndex: number): GraphicsStillProps => ({
    document: input.document,
    frame: input.frame,
    durationSeconds: input.durationSeconds,
    images,
    fontUrls: null,
    groupIndex,
  });
  const composition = await selectComposition({
    serveUrl: bundleDir,
    id: COMPOSITION_ID,
    inputProps: props(0),
    puppeteerInstance: browser,
    timeoutInMilliseconds: SELECT_TIMEOUT_MS,
  });
  const rendered: RenderedGraphicsStill[] = [];
  for (const [index, group] of groups.entries()) {
    const path = join(input.outputDir, `graphics-${index + 1}.png`);
    const inputProps = props(index);
    await drawStill(input, inputProps, composition, bundleDir, browser, path);
    const transitions = await renderTransitions(input, group, index, inputProps, composition, bundleDir, browser);
    rendered.push({ ...group, path, ...(transitions.length > 0 ? { transitions } : {}) });
  }
  return rendered;
}

export async function renderGraphicsStills(input: GraphicsStillsInput): Promise<{ groups: RenderedGraphicsStill[] }> {
  const groups = graphicsStillGroups(input.document, input.durationSeconds);
  if (groups.length === 0) return { groups: [] };
  input.signal.throwIfAborted();
  const bundleDir = await getSharedBundleLocation();
  const staged: string[] = [];
  let browser: HeadlessBrowser | null = null;
  try {
    const images = await stageImages(bundleDir, drawnImageIds(input.document, groups), input.images, staged);
    input.signal.throwIfAborted();
    browser = await openStillBrowser();
    return { groups: await renderGroups(input, groups, bundleDir, images, browser) };
  } finally {
    await browser?.close({ silent: true });
    await Promise.all(staged.map((path) => rm(path, { force: true })));
  }
}
