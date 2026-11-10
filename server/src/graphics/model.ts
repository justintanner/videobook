import { z } from "zod";

export const GRAPHICS_DOCUMENT_VERSION = 1;
export const MAX_GRAPHICS_LAYERS = 24;
export const MAX_GRAPHICS_ITEMS = 6;
export const MAX_GRAPHICS_TEXT_LENGTH = 280;
export const MAX_GRAPHICS_NAME_LENGTH = 80;
export const MAX_GRAPHICS_FADE_SECONDS = 2;
export const MAX_GRAPHICS_PLATE_PADDING = 0.2;
export const GRAPHICS_INSET_FRACTION = 0.02;
const MAX_GRAPHICS_URL_LENGTH = 512;
const MAX_GRAPHICS_LINES = 6;
const MAX_FRAME_SIDE = 16_384;

export const GRAPHICS_LAYER_KINDS = ["text", "image", "qr", "scrim"] as const;
const ANCHORS = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] as const;
const SPACES = ["safe", "inset", "frame"] as const;
const TEXT_SLOTS = ["headline", "secondary", "credit", "handle"] as const;
const QR_SLOTS = ["profile"] as const;
const FONT_PRESETS = ["heavy", "display", "text"] as const;
const ICONS = ["camera", "link", "music", "pin", "tiktok", "x"] as const;
const ACCENTS = ["none", "underline", "brush"] as const;
const ALIGNS = ["left", "center", "right"] as const;
const CASES = ["none", "upper"] as const;
const QR_STYLES = ["plain", "tile"] as const;
const QR_LEVELS = ["L", "M", "Q", "H"] as const;
const SCRIM_EDGES = ["top", "bottom"] as const;

export type GraphicsLayerKind = typeof GRAPHICS_LAYER_KINDS[number];
export type GraphicsAnchor = typeof ANCHORS[number];
export type GraphicsSpace = typeof SPACES[number];
export type GraphicsTextSlot = typeof TEXT_SLOTS[number];
export type GraphicsQrSlot = typeof QR_SLOTS[number];
export type GraphicsSlot = GraphicsTextSlot | GraphicsQrSlot;
export type GraphicsFontPreset = typeof FONT_PRESETS[number];
export type GraphicsIcon = typeof ICONS[number];
export type GraphicsAccent = typeof ACCENTS[number];

const COLOR_MESSAGE = "Colours are #RRGGBB hex strings.";

function between(min: number, max: number, message: string) {
  return z.number({ error: message }).min(min, message).max(max, message);
}

function wholeBetween(min: number, max: number, message: string) {
  return between(min, max, message).int(message);
}

function oneOf<const T extends readonly [string, ...string[]]>(values: T, label: string) {
  return z.enum(values, { error: `${label} must be one of ${values.join(", ")}.` });
}

function flag(label: string) {
  return z.boolean({ error: `${label} must be true or false.` });
}

function seconds(label: string) {
  const message = `${label} must be null or at least 0 seconds.`;
  return z.number({ error: message }).min(0, message).nullable();
}

function text(label: string, max: number) {
  const message = `${label} is limited to ${max} characters.`;
  return z.string({ error: `${label} must be a string.` }).max(max, message);
}

function parsesAsUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function isGraphicsUrl(value: string): boolean {
  return value.length <= MAX_GRAPHICS_URL_LENGTH && /^https?:\/\/\S+$/iu.test(value) && parsesAsUrl(value);
}

const hexColor = z.string({ error: COLOR_MESSAGE }).regex(/^#[0-9a-fA-F]{6}$/u, COLOR_MESSAGE);

const positionSchema = z.object({
  anchor: oneOf(ANCHORS, "Anchor"),
  x: between(0, 1, "x must be between 0 and 1 of the positioning space."),
  y: between(0, 1, "y must be between 0 and 1 of the positioning space."),
  space: oneOf(SPACES, "Space"),
}).strict();

const timingSchema = z.object({
  start: seconds("Start"),
  end: seconds("End"),
  tail: seconds("Tail"),
  fade: between(0, MAX_GRAPHICS_FADE_SECONDS, `Fade must be between 0 and ${MAX_GRAPHICS_FADE_SECONDS} seconds.`),
}).strict();

const plateSchema = z.object({
  color: hexColor,
  opacity: between(0, 1, "Plate opacity must be between 0 and 1."),
  paddingX: between(0, MAX_GRAPHICS_PLATE_PADDING, `Plate padding must be between 0 and ${MAX_GRAPHICS_PLATE_PADDING} of the frame's short side.`),
  paddingY: between(0, MAX_GRAPHICS_PLATE_PADDING, `Plate padding must be between 0 and ${MAX_GRAPHICS_PLATE_PADDING} of the frame's short side.`),
  radius: between(0, 1, "Plate radius must be between 0 and 1 of half the plate height."),
  border: flag("Plate border"),
}).strict();

const textItemSchema = z.object({
  id: z.string({ error: "Item ids look like t1." }).regex(/^t\d+$/u, "Item ids look like t1."),
  text: text("Text", MAX_GRAPHICS_TEXT_LENGTH),
  slot: oneOf(TEXT_SLOTS, "Text slot").nullable(),
  font: oneOf(FONT_PRESETS, "Font preset"),
  size: between(0.01, 0.3, "Text size must be between 0.01 and 0.3 of the frame's short side."),
  color: hexColor,
  case: oneOf(CASES, "Case"),
  maxLines: wholeBetween(1, MAX_GRAPHICS_LINES, `Max lines must be a whole number from 1 to ${MAX_GRAPHICS_LINES}.`),
  icon: oneOf(ICONS, "Icon").nullable(),
  accent: oneOf(ACCENTS, "Accent"),
  outline: flag("Outline"),
  shadow: flag("Shadow"),
}).strict();

const layerFields = {
  id: z.string({ error: "Layer ids look like l1." }).regex(/^l\d+$/u, "Layer ids look like l1."),
  name: text("Layer name", MAX_GRAPHICS_NAME_LENGTH),
  visible: flag("Visible"),
  opacity: between(0.05, 1, "Opacity must be between 0.05 and 1."),
  timing: timingSchema,
};

const itemsMessage = `A text layer holds 1 to ${MAX_GRAPHICS_ITEMS} items.`;

const textLayerSchema = z.object({
  ...layerFields,
  kind: z.literal("text"),
  position: positionSchema,
  width: between(0.1, 1, "Text width must be between 0.1 and 1 of the positioning space's width."),
  align: oneOf(ALIGNS, "Align"),
  gap: between(0, 0.1, "Gap must be between 0 and 0.1 of the frame's short side."),
  plate: plateSchema.nullable(),
  items: z.array(textItemSchema).min(1, itemsMessage).max(MAX_GRAPHICS_ITEMS, itemsMessage),
}).strict();

const imageLayerSchema = z.object({
  ...layerFields,
  kind: z.literal("image"),
  artifactId: z.string({ error: "Image layers name an image artifact." }).min(1, "Image layers name an image artifact.").max(200, "Artifact ids are limited to 200 characters."),
  position: positionSchema,
  size: between(0.02, 1, "Image size must be between 0.02 and 1 of the frame's short side."),
}).strict();

const urlMessage = `QR URLs start with http:// or https:// and are at most ${MAX_GRAPHICS_URL_LENGTH} characters.`;

const qrLayerSchema = z.object({
  ...layerFields,
  kind: z.literal("qr"),
  url: z.string({ error: urlMessage }).refine((url) => url === "" || isGraphicsUrl(url), urlMessage),
  slot: oneOf(QR_SLOTS, "QR slot").nullable(),
  position: positionSchema,
  size: between(0.05, 0.6, "QR size must be between 0.05 and 0.6 of the frame's short side."),
  style: oneOf(QR_STYLES, "QR style"),
  dark: hexColor,
  light: hexColor,
  level: oneOf(QR_LEVELS, "QR level"),
}).strict().superRefine((layer, context) => {
  if (layer.url === "" && layer.slot === null) {
    context.addIssue({ code: "custom", path: ["url"], message: "A QR code needs an http or https URL unless it fills the profile slot." });
  }
});

const scrimLayerSchema = z.object({
  ...layerFields,
  kind: z.literal("scrim"),
  edge: oneOf(SCRIM_EDGES, "Scrim edge"),
  height: between(0.05, 1, "Scrim height must be between 0.05 and 1 of the frame height."),
  color: hexColor,
  strength: between(0, 1, "Scrim strength must be between 0 and 1."),
}).strict();

const layerSchema = z.discriminatedUnion(
  "kind",
  [textLayerSchema, imageLayerSchema, qrLayerSchema, scrimLayerSchema],
  { error: `Layer kind must be one of ${GRAPHICS_LAYER_KINDS.join(", ")}.` },
);

function firstDuplicate(ids: readonly string[]): string | null {
  return ids.find((id, index) => ids.indexOf(id) !== index) ?? null;
}

function idNumber(id: string): number {
  return Number(id.slice(1)) || 0;
}

const graphicsDocumentSchema = z.object({
  version: z.literal(GRAPHICS_DOCUMENT_VERSION, { error: `Graphics documents are version ${GRAPHICS_DOCUMENT_VERSION}.` }),
  layers: z.array(layerSchema).max(MAX_GRAPHICS_LAYERS, `A document holds at most ${MAX_GRAPHICS_LAYERS} layers.`),
  nextId: z.number({ error: "nextId must be a whole number above 0." }).int("nextId must be a whole number above 0.").positive("nextId must be a whole number above 0."),
}).strict().superRefine((document, context) => {
  const layerIds = document.layers.map((layer) => layer.id);
  const itemIds = document.layers.flatMap((layer) => (layer.kind === "text" ? layer.items.map((item) => item.id) : []));
  const duplicate = firstDuplicate(layerIds) ?? firstDuplicate(itemIds);
  if (duplicate) context.addIssue({ code: "custom", path: ["layers"], message: `Id ${duplicate} appears twice.` });
  const highest = Math.max(0, ...layerIds.map(idNumber), ...itemIds.map(idNumber));
  if (document.nextId <= highest) {
    context.addIssue({ code: "custom", path: ["nextId"], message: `nextId must be above ${highest}, the highest id in use.` });
  }
});

const frameSide = wholeBetween(1, MAX_FRAME_SIDE, `Frame sides must be whole numbers from 1 to ${MAX_FRAME_SIDE} pixels.`);

const graphicsFrameSchema = z.object({ width: frameSide, height: frameSide }).strict();

export type GraphicsPosition = z.infer<typeof positionSchema>;
export type GraphicsTiming = z.infer<typeof timingSchema>;
export type GraphicsPlate = z.infer<typeof plateSchema>;
export type GraphicsTextItem = z.infer<typeof textItemSchema>;
export type GraphicsTextLayer = z.infer<typeof textLayerSchema>;
export type GraphicsImageLayer = z.infer<typeof imageLayerSchema>;
export type GraphicsQrLayer = z.infer<typeof qrLayerSchema>;
export type GraphicsScrimLayer = z.infer<typeof scrimLayerSchema>;
export type GraphicsLayer = z.infer<typeof layerSchema>;
export type GraphicsDocument = z.infer<typeof graphicsDocumentSchema>;
export type GraphicsFrame = z.infer<typeof graphicsFrameSchema>;

export const GRAPHICS_ANCHOR_POINTS: Record<GraphicsAnchor, { x: number; y: number }> = {
  "top-left": { x: 0, y: 0 },
  top: { x: 0.5, y: 0 },
  "top-right": { x: 1, y: 0 },
  left: { x: 0, y: 0.5 },
  center: { x: 0.5, y: 0.5 },
  right: { x: 1, y: 0.5 },
  "bottom-left": { x: 0, y: 1 },
  bottom: { x: 0.5, y: 1 },
  "bottom-right": { x: 1, y: 1 },
};

export type GraphicsParseResult =
  | { ok: true; document: GraphicsDocument }
  | { ok: false; error: string; issues: string[] };

type GraphicsIssue = z.ZodError["issues"][number];

function issuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((joined, key) => {
    if (typeof key === "number") return `${joined}[${key}]`;
    return joined ? `${joined}.${String(key)}` : String(key);
  }, "");
}

function describeIssue(issue: GraphicsIssue): string {
  const message = issue.code === "unrecognized_keys"
    ? `Unknown field${issue.keys.length > 1 ? "s" : ""} ${issue.keys.map((key) => `"${key}"`).join(", ")}.`
    : issue.message;
  const path = issuePath(issue.path);
  return path ? `${path}: ${message}` : message;
}

export function parseGraphicsDocument(value: unknown): GraphicsParseResult {
  const parsed = graphicsDocumentSchema.safeParse(value);
  if (parsed.success) return { ok: true, document: parsed.data };
  const issues = parsed.error.issues.map(describeIssue);
  return { ok: false, error: issues[0] ?? "Invalid graphics document.", issues };
}

export function graphicsFrame(value: GraphicsFrame): GraphicsFrame {
  const parsed = graphicsFrameSchema.safeParse({ width: value.width, height: value.height });
  if (!parsed.success) throw new Error(parsed.error.issues.map(describeIssue).join(" "));
  return parsed.data;
}

export function emptyGraphicsDocument(): GraphicsDocument {
  return { version: GRAPHICS_DOCUMENT_VERSION, layers: [], nextId: 1 };
}

export function nextGraphicsId(nextId: number, prefix: "l" | "t"): { id: string; nextId: number } {
  return { id: `${prefix}${nextId}`, nextId: nextId + 1 };
}

export function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

export function normalizeGraphicsText(value: string): string {
  return typeof value === "string" ? value.replace(/\r\n?/gu, "\n") : value;
}

export type GraphicsTextItemInput = Partial<Omit<GraphicsTextItem, "id">>;
export type GraphicsPlateInput = Partial<GraphicsPlate>;

type LayerInputFields = {
  name?: string;
  visible?: boolean;
  opacity?: number;
  timing?: Partial<GraphicsTiming>;
};

type PlacedInputFields = { position?: Partial<GraphicsPosition> };

export type GraphicsTextLayerInput = LayerInputFields & PlacedInputFields & Partial<Pick<GraphicsTextLayer, "width" | "align" | "gap">> & {
  kind: "text";
  plate?: GraphicsPlateInput | null;
  items?: readonly GraphicsTextItemInput[];
};

export type GraphicsImageLayerInput = LayerInputFields & PlacedInputFields & Partial<Pick<GraphicsImageLayer, "size">> & {
  kind: "image";
  artifactId: string;
};

export type GraphicsQrLayerInput = LayerInputFields & PlacedInputFields
  & Partial<Pick<GraphicsQrLayer, "url" | "slot" | "size" | "style" | "dark" | "light" | "level">> & { kind: "qr" };

export type GraphicsScrimLayerInput = LayerInputFields & Partial<Pick<GraphicsScrimLayer, "edge" | "height" | "color" | "strength">> & {
  kind: "scrim";
};

export type GraphicsLayerInput = GraphicsTextLayerInput | GraphicsImageLayerInput | GraphicsQrLayerInput | GraphicsScrimLayerInput;

const WHOLE_CLIP: GraphicsTiming = { start: null, end: null, tail: null, fade: 0 };

export const DEFAULT_GRAPHICS_PLATE: GraphicsPlate = {
  color: "#000000",
  opacity: 0.6,
  paddingX: 0.02,
  paddingY: 0.012,
  radius: 0.5,
  border: false,
};

const DEFAULT_TEXT_ITEM: Omit<GraphicsTextItem, "id"> = {
  text: "",
  slot: null,
  font: "heavy",
  size: 0.05,
  color: "#FFFFFF",
  case: "none",
  maxLines: 2,
  icon: null,
  accent: "none",
  outline: false,
  shadow: true,
};

const DEFAULT_POSITIONS: Record<"text" | "image" | "qr", GraphicsPosition> = {
  text: { anchor: "center", x: 0.5, y: 0.5, space: "safe" },
  image: { anchor: "top-left", x: 0, y: 0, space: "safe" },
  qr: { anchor: "bottom-right", x: 1, y: 1, space: "inset" },
};

const DEFAULT_NAMES: Record<GraphicsLayerKind, string> = {
  text: "Text",
  image: "Image",
  qr: "QR code",
  scrim: "Shade",
};

type MintedLayer = { layer: GraphicsLayer; nextId: number };

function commonFields(input: LayerInputFields, kind: GraphicsLayerKind, id: string) {
  return {
    id,
    name: input.name ?? DEFAULT_NAMES[kind],
    visible: input.visible ?? true,
    opacity: input.opacity ?? 1,
    timing: { ...WHOLE_CLIP, ...definedFields(input.timing ?? {}) },
  };
}

function positionFrom(input: PlacedInputFields, kind: "text" | "image" | "qr"): GraphicsPosition {
  return { ...DEFAULT_POSITIONS[kind], ...definedFields(input.position ?? {}) };
}

export function textItemFrom(input: GraphicsTextItemInput, id: string): GraphicsTextItem {
  return { ...DEFAULT_TEXT_ITEM, ...definedFields(input), id, text: normalizeGraphicsText(input.text ?? "") };
}

function mintItems(inputs: readonly GraphicsTextItemInput[], nextId: number): { items: GraphicsTextItem[]; nextId: number } {
  return inputs.reduce<{ items: GraphicsTextItem[]; nextId: number }>((state, input) => {
    const minted = nextGraphicsId(state.nextId, "t");
    return { items: [...state.items, textItemFrom(input, minted.id)], nextId: minted.nextId };
  }, { items: [], nextId });
}

function plateFrom(input: GraphicsPlateInput | null | undefined): GraphicsPlate | null {
  return input ? { ...DEFAULT_GRAPHICS_PLATE, ...definedFields(input) } : null;
}

function textLayerFrom(input: GraphicsTextLayerInput, id: string, nextId: number): MintedLayer {
  const minted = mintItems(input.items ?? [{}], nextId);
  const layer: GraphicsTextLayer = {
    width: 0.9,
    align: "center",
    gap: 0.012,
    ...definedFields(input),
    ...commonFields(input, "text", id),
    kind: "text",
    position: positionFrom(input, "text"),
    plate: plateFrom(input.plate),
    items: minted.items,
  };
  return { layer, nextId: minted.nextId };
}

function imageLayerFrom(input: GraphicsImageLayerInput, id: string): GraphicsImageLayer {
  return {
    size: 0.2,
    ...definedFields(input),
    ...commonFields(input, "image", id),
    kind: "image",
    artifactId: input.artifactId,
    position: positionFrom(input, "image"),
  };
}

function qrLayerFrom(input: GraphicsQrLayerInput, id: string): GraphicsQrLayer {
  return {
    url: "",
    slot: "profile",
    size: 0.16,
    style: "tile",
    dark: "#0B0B0F",
    light: "#FFFFFF",
    level: "H",
    ...definedFields(input),
    ...commonFields(input, "qr", id),
    kind: "qr",
    position: positionFrom(input, "qr"),
  };
}

function scrimLayerFrom(input: GraphicsScrimLayerInput, id: string): GraphicsScrimLayer {
  return {
    edge: "bottom",
    height: 0.4,
    color: "#000000",
    strength: 0.7,
    ...definedFields(input),
    ...commonFields(input, "scrim", id),
    kind: "scrim",
  };
}

export function createGraphicsLayer(input: GraphicsLayerInput, nextId: number): MintedLayer {
  const minted = nextGraphicsId(nextId, "l");
  switch (input.kind) {
    case "text": return textLayerFrom(input, minted.id, minted.nextId);
    case "image": return { layer: imageLayerFrom(input, minted.id), nextId: minted.nextId };
    case "qr": return { layer: qrLayerFrom(input, minted.id), nextId: minted.nextId };
    case "scrim": return { layer: scrimLayerFrom(input, minted.id), nextId: minted.nextId };
  }
}

export function appendGraphicsLayers(document: GraphicsDocument, inputs: readonly GraphicsLayerInput[]): GraphicsDocument {
  return inputs.reduce<GraphicsDocument>((current, input) => {
    const { layer, nextId } = createGraphicsLayer(input, current.nextId);
    return { ...current, layers: [...current.layers, layer], nextId };
  }, document);
}

export function graphicsDocumentFromLayers(inputs: readonly GraphicsLayerInput[]): GraphicsDocument {
  return appendGraphicsLayers(emptyGraphicsDocument(), inputs);
}
