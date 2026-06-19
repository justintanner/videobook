import type { VideocityFs } from "videocity-engine";
import sharp from "sharp";
import { z, type ZodRawShape } from "zod";
import { cropToFill, probeImage } from "../image.js";
import { findImageFile } from "./_image-inputs.js";
import { slugify } from "./_fal-shared.js";
import type { SchemaArgs, ToolDef, ToolResult } from "./tool-def.js";

const layoutOptions = ["horizontal", "vertical", "grid"] as const;
const aspectRatioOptions = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

const concatImagesSchema = {
  image_slugs: z.array(z.string()).min(2).max(9).describe("Image asset slugs to concatenate, e.g. ['@img-a', '@img-b']"),
  project_slug: z.string().describe("Project slug"),
  layout: z.enum(layoutOptions).optional().describe("Cell layout. Defaults to horizontal for 2 images, grid for 3+ images."),
  aspect_ratio: z.enum(aspectRatioOptions).optional().describe("Output aspect ratio. Defaults to 16:9 for video generation."),
  name: z.string().optional().describe("Optional name for the generated img-* asset"),
  background: z.string().optional().describe("Background color for padding, e.g. #000000 or white. Defaults to #000000."),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof concatImagesSchema>;
type Layout = (typeof layoutOptions)[number];
type AspectRatio = (typeof aspectRatioOptions)[number];

type SourceImage = {
  assetId: string;
  filename: string;
  buffer: Buffer;
};

type Dimensions = {
  width: number;
  height: number;
};

type Grid = {
  columns: number;
  rows: number;
};

type Placement = {
  asset_id: string;
  filename: string;
  cell: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

const dimensionsByAspectRatio: Record<AspectRatio, Dimensions> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
};

export function concatImagesDef(fs: VideocityFs): ToolDef {
  return {
    name: "concat_images",
    description:
      "Concatenate 2-9 image assets into a new img-* asset. Each source image is fit into its cell without stretching, so aspect ratios are preserved for video-generation reference sheets.",
    schema: concatImagesSchema,
    handler: async (args) => {
      const {
        image_slugs,
        project_slug,
        layout,
        aspect_ratio,
        name,
        background,
      } = args as Args;

      const sourceResult = await readSourceImages(fs, image_slugs, project_slug);
      if (!sourceResult.ok) return error(sourceResult.error);

      const resolvedLayout = layout ?? (sourceResult.value.length <= 2 ? "horizontal" : "grid");
      const resolvedAspectRatio = aspect_ratio ?? "16:9";
      const dimensions = dimensionsByAspectRatio[resolvedAspectRatio];
      const resolvedBackground = background ?? "#000000";
      let output: Awaited<ReturnType<typeof renderConcat>>;
      try {
        output = await renderConcat(
          sourceResult.value,
          resolvedLayout,
          dimensions,
          resolvedBackground,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return error(`Failed to concatenate images: ${message}`);
      }

      const assetName = name ?? deriveAssetName(sourceResult.value.map((source) => source.assetId));
      const assetResult = await fs.createAsset("img", assetName, project_slug);
      if (!assetResult.ok) return error(`Failed to create image asset: ${assetResult.error.message}`);

      const imgAssetId = assetResult.value.assetId;
      const writeResult = await fs.writeFile(imgAssetId, "original.png", output.buffer, project_slug);
      if (!writeResult.ok) {
        await fs.deleteAsset(imgAssetId, project_slug).catch(() => undefined);
        return error(writeResult.error.message);
      }

      const metadata = {
        origin: "concat_images",
        created_at: new Date().toISOString(),
        width: output.dimensions.width,
        height: output.dimensions.height,
        layout: resolvedLayout,
        aspect_ratio: resolvedAspectRatio,
        source_images: sourceResult.value.map((source) => source.assetId),
      };
      const metadataResult = await fs.writeMetadata(imgAssetId, "original", metadata, project_slug);
      if (!metadataResult.ok) {
        await fs.deleteAsset(imgAssetId, project_slug).catch(() => undefined);
        return error(metadataResult.error.message);
      }

      let variantsResult: Awaited<ReturnType<typeof writeImageVariants>>;
      try {
        variantsResult = await writeImageVariants(fs, imgAssetId, output.buffer, project_slug);
      } catch (e) {
        await fs.deleteAsset(imgAssetId, project_slug).catch(() => undefined);
        const message = e instanceof Error ? e.message : String(e);
        return error(`Failed to write image variants: ${message}`);
      }
      if (!variantsResult.ok) {
        await fs.deleteAsset(imgAssetId, project_slug).catch(() => undefined);
        return error(variantsResult.error);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            img_asset_id: imgAssetId,
            asset_id: imgAssetId,
            filename: "original.png",
            width: output.dimensions.width,
            height: output.dimensions.height,
            layout: resolvedLayout,
            aspect_ratio: resolvedAspectRatio,
            source_images: sourceResult.value.map((source) => source.assetId),
            placements: output.placements,
          }),
        }],
      };
    },
  };
}

async function readSourceImages(
  fs: VideocityFs,
  rawSlugs: readonly string[],
  projectSlug: string,
): Promise<{ ok: true; value: SourceImage[] } | { ok: false; error: string }> {
  const sources: SourceImage[] = [];
  for (const rawSlug of rawSlugs) {
    const assetId = rawSlug.replace(/^@/, "");
    if (!assetId.startsWith("img-") && !assetId.startsWith("char-")) {
      return { ok: false, error: `image_slugs entries must be img-* or char-* assets, got: ${assetId}` };
    }

    const manifestResult = await fs.getManifest(assetId, projectSlug);
    if (!manifestResult.ok) return { ok: false, error: manifestResult.error.message };

    const imageFile = findImageFile(manifestResult.value.files);
    if (!imageFile) return { ok: false, error: `No image file found in asset ${assetId}` };

    const readResult = await fs.readFile(assetId, imageFile.name, projectSlug);
    if (!readResult.ok) return { ok: false, error: readResult.error.message };

    const buffer = Buffer.isBuffer(readResult.value)
      ? readResult.value
      : Buffer.from(readResult.value);
    let dimensions: Dimensions;
    try {
      dimensions = await probeImage(buffer);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Failed to read ${assetId}/${imageFile.name}: ${message}` };
    }
    if (dimensions.width <= 0 || dimensions.height <= 0) {
      return { ok: false, error: `Could not determine dimensions for ${assetId}/${imageFile.name}` };
    }

    sources.push({ assetId, filename: imageFile.name, buffer });
  }
  return { ok: true, value: sources };
}

async function renderConcat(
  sources: readonly SourceImage[],
  layout: Layout,
  dimensions: Dimensions,
  background: string,
): Promise<{ buffer: Buffer; dimensions: Dimensions; placements: Placement[] }> {
  const grid = resolveGrid(sources.length, layout);
  const composites = await Promise.all(sources.map(async (source, index) => {
    const cell = cellFor(index, grid, dimensions);
    const input = await sharp(source.buffer)
      .rotate()
      .resize(cell.width, cell.height, { fit: "contain", background })
      .png()
      .toBuffer();
    return {
      composite: { input, left: cell.x, top: cell.y },
      placement: {
        asset_id: source.assetId,
        filename: source.filename,
        cell,
      },
    };
  }));

  const buffer = await sharp({
    create: {
      width: dimensions.width,
      height: dimensions.height,
      channels: 4,
      background,
    },
  })
    .composite(composites.map((entry) => entry.composite))
    .png()
    .toBuffer();

  return {
    buffer,
    dimensions,
    placements: composites.map((entry) => entry.placement),
  };
}

function resolveGrid(count: number, layout: Layout): Grid {
  if (layout === "horizontal") return { columns: count, rows: 1 };
  if (layout === "vertical") return { columns: 1, rows: count };
  const columns = Math.ceil(Math.sqrt(count));
  return { columns, rows: Math.ceil(count / columns) };
}

function cellFor(index: number, grid: Grid, dimensions: Dimensions): Placement["cell"] {
  const column = index % grid.columns;
  const row = Math.floor(index / grid.columns);
  const x = Math.floor((dimensions.width * column) / grid.columns);
  const y = Math.floor((dimensions.height * row) / grid.rows);
  const nextX = Math.floor((dimensions.width * (column + 1)) / grid.columns);
  const nextY = Math.floor((dimensions.height * (row + 1)) / grid.rows);
  return {
    x,
    y,
    width: nextX - x,
    height: nextY - y,
  };
}

export async function writeImageVariants(
  fs: VideocityFs,
  assetId: string,
  buffer: Buffer,
  projectSlug: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [landscape, portrait, square] = await Promise.all([
    cropToFill(buffer, 1920, 1080),
    cropToFill(buffer, 1080, 1920),
    cropToFill(buffer, 1080, 1080),
  ]);
  const results = await Promise.all([
    fs.writeFile(assetId, "landscape.jpg", landscape, projectSlug),
    fs.writeFile(assetId, "portrait.jpg", portrait, projectSlug),
    fs.writeFile(assetId, "square.jpg", square, projectSlug),
  ]);
  const failure = results.find((result) => !result.ok);
  if (failure && !failure.ok) return { ok: false, error: failure.error.message };
  return { ok: true };
}

function deriveAssetName(assetIds: readonly string[]): string {
  const base = assetIds
    .map((assetId) => assetId.replace(/^(img|char)-/, ""))
    .join("-");
  return `concat-${slugify(base) || String(Date.now())}`;
}

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}
