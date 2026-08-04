import type { Engine } from "videobook-engine";
import sharp from "sharp";
import { z, type ZodRawShape } from "zod";
import { cropToFill, probeImage } from "../image.js";
import { findImageFile } from "./_image-inputs.js";
import { slugify } from "./_fal-shared.js";
import type { SchemaArgs, ToolDef, ToolResult } from "./tool-def.js";

const layoutOptions = ["horizontal", "vertical", "grid"] as const;
const aspectRatioOptions = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

const concatImagesSchema = {
  image_refs: z.array(z.string().nullable()).min(1).max(9).describe("Image artifact ids to concatenate. For a two-slot sheet, pass one id to leave the second slot empty or use null for an explicit empty slot."),
  book_id: z.string().describe("Book id"),
  layout: z.enum(layoutOptions).optional().describe("Cell layout. Defaults to horizontal for landscape two-slot sheets, vertical for portrait two-slot sheets, and grid for 3+ images."),
  aspect_ratio: z.enum(aspectRatioOptions).optional().describe("Output aspect ratio. Defaults to 16:9 for video generation."),
  name: z.string().optional().describe("Optional name for the generated image artifact"),
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

type SourceImageSlot = SourceImage | null;

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

export function concatImagesDef(fs: Engine): ToolDef {
  return {
    name: "concat_images",
    description:
      "Concatenate 1-9 image artifacts into a new image artifact. One or two inputs use a fixed two-slot sheet, with landscape images side-by-side and portrait images stacked. A missing slot stays as background, and each source image is fit into its cell without stretching.",
    schema: concatImagesSchema,
    handler: async (args) => {
      const {
        image_refs,
        book_id,
        layout,
        aspect_ratio,
        name,
        background,
      } = args as Args;

      const sourceResult = await readSourceImages(fs, image_refs, book_id);
      if (!sourceResult.ok) return error(sourceResult.error);
      if (!sourceResult.value.some((source) => source !== null)) {
        return error("At least one image asset is required");
      }

      const resolvedAspectRatio = aspect_ratio ?? "16:9";
      const resolvedLayout = layout ?? defaultLayout(resolvedAspectRatio, sourceResult.value.length);
      const dimensions = dimensionsByAspectRatio[resolvedAspectRatio];
      const resolvedBackground = background ?? "#000000";
      const sourceImageIds = sourceResult.value.flatMap((source) => source ? [source.assetId] : []);
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

      const assetName = name ?? deriveAssetName(sourceImageIds);
      const assetResult = await fs.artifacts.create("img", assetName);
      if (!assetResult.ok) return error(`Failed to create image asset: ${assetResult.error.message}`);

      const imgAssetId = assetResult.value.artifactId;
      const writeResult = await fs.files.write(imgAssetId, "original.png", output.buffer);
      if (!writeResult.ok) {
        await fs.artifacts.delete(imgAssetId).catch(() => undefined);
        return error(writeResult.error.message);
      }

      const metadata = {
        origin: "concat_images",
        created_at: new Date().toISOString(),
        width: output.dimensions.width,
        height: output.dimensions.height,
        layout: resolvedLayout,
        aspect_ratio: resolvedAspectRatio,
        source_images: sourceImageIds,
      };
      const metadataResult = await fs.metadata.artifacts.write(imgAssetId, "original", metadata);
      if (!metadataResult.ok) {
        await fs.artifacts.delete(imgAssetId).catch(() => undefined);
        return error(metadataResult.error.message);
      }

      let variantsResult: Awaited<ReturnType<typeof writeImageVariants>>;
      try {
        variantsResult = await writeImageVariants(fs, imgAssetId, output.buffer, book_id);
      } catch (e) {
        await fs.artifacts.delete(imgAssetId).catch(() => undefined);
        const message = e instanceof Error ? e.message : String(e);
        return error(`Failed to write image variants: ${message}`);
      }
      if (!variantsResult.ok) {
        await fs.artifacts.delete(imgAssetId).catch(() => undefined);
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
            source_images: sourceImageIds,
            placements: output.placements,
          }),
        }],
      };
    },
  };
}

async function readSourceImages(
  fs: Engine,
  rawRefs: readonly (string | null)[],
  _bookId: string,
): Promise<{ ok: true; value: SourceImageSlot[] } | { ok: false; error: string }> {
  const sources: SourceImageSlot[] = [];
  for (const rawRef of rawRefs) {
    if (rawRef === null || rawRef.trim() === "") {
      sources.push(null);
      continue;
    }
    const assetId = rawRef.replace(/^@/, "");
    const artifact = fs.artifacts.get(assetId);
    if (!artifact.ok) return { ok: false, error: artifact.error.message };
    if (artifact.value.kind !== "image") {
      return { ok: false, error: `image ref must be an image artifact, got ${artifact.value.kind}: ${assetId}` };
    }

    const manifestResult = await fs.files.manifest(assetId);
    if (!manifestResult.ok) return { ok: false, error: manifestResult.error.message };

    const imageFile = findImageFile(manifestResult.value.files);
    if (!imageFile) return { ok: false, error: `No image file found in asset ${assetId}` };

    const readResult = await fs.files.read(assetId, imageFile.name);
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
  sources: readonly SourceImageSlot[],
  layout: Layout,
  dimensions: Dimensions,
  background: string,
): Promise<{ buffer: Buffer; dimensions: Dimensions; placements: Placement[] }> {
  const grid = resolveGrid(sources.length <= 2 ? 2 : sources.length, layout);
  const composites = await Promise.all(sources.map(async (source, index) => {
    if (!source) return null;
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

  const populatedComposites = composites.filter((entry): entry is Exclude<typeof entry, null> => entry !== null);
  const buffer = await sharp({
    create: {
      width: dimensions.width,
      height: dimensions.height,
      channels: 4,
      background,
    },
  })
    .composite(populatedComposites.map((entry) => entry.composite))
    .png()
    .toBuffer();

  return {
    buffer,
    dimensions,
    placements: populatedComposites.map((entry) => entry.placement),
  };
}

function defaultLayout(aspectRatio: AspectRatio, slotCount: number): Layout {
  if (slotCount > 2) return "grid";
  return aspectRatio === "9:16" || aspectRatio === "3:4" ? "vertical" : "horizontal";
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
  fs: Engine,
  assetId: string,
  buffer: Buffer,
  _bookId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [landscape, portrait, square] = await Promise.all([
    cropToFill(buffer, 1920, 1080),
    cropToFill(buffer, 1080, 1920),
    cropToFill(buffer, 1080, 1080),
  ]);
  const results = await Promise.all([
    fs.files.write(assetId, "landscape.jpg", landscape),
    fs.files.write(assetId, "portrait.jpg", portrait),
    fs.files.write(assetId, "square.jpg", square),
  ]);
  const failure = results.find((result) => !result.ok);
  if (failure && !failure.ok) return { ok: false, error: failure.error.message };
  return { ok: true };
}

function deriveAssetName(assetIds: readonly string[]): string {
  const base = assetIds.join("-");
  return `concat-${slugify(base) || String(Date.now())}`;
}

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}
