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
export type RenderedGraphicsStill = GraphicsStillGroup & { path: string };

type GraphicsStillsInput = {
  document: GraphicsDocument;
  frame: GraphicsFrame;
  durationSeconds: number;
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

async function stageImages(
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
    await withRemotionCancellation(input.signal, (cancelSignal) => renderStill({
      composition: { ...composition, props: inputProps },
      serveUrl: bundleDir,
      output: path,
      overwrite: true,
      imageFormat: "png",
      inputProps,
      puppeteerInstance: browser,
      cancelSignal,
    }));
    rendered.push({ ...group, path });
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
