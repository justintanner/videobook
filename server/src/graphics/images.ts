import type { Engine } from "videobook-engine";
import type { GraphicsDocument } from "./model.js";
import { drawnImageLayers, graphicsImagePath, graphicsImageSize } from "./render.js";
import type { GraphicsStillImage } from "./render-stills.js";

export async function graphicsDocumentImages(engine: Engine, document: GraphicsDocument, durationSeconds: number): Promise<Record<string, GraphicsStillImage>> {
  const entries = await Promise.all(drawnImageLayers(document, durationSeconds).map(async layer => {
    const path = await graphicsImagePath(engine, layer.artifactId);
    if (!path) throw new Error(`Layer ${layer.id} shows an image that is no longer in this book. Choose another image or remove the layer, then render again.`);
    const size = await graphicsImageSize(path);
    if (!size) throw new Error(`Layer ${layer.id} shows an image whose size cannot be read.`);
    return [layer.artifactId, { path, ...size }] as const;
  }));
  return Object.fromEntries(entries);
}
