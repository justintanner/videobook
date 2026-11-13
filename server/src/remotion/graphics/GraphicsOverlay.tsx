import React, { useEffect, useMemo } from "react";
import { AbsoluteFill, Img } from "remotion";
import { GRAPHICS_ICON_PATHS, GRAPHICS_ICON_VIEWBOX } from "../../graphics/icons.js";
import type {
  GraphicsImageLayout,
  GraphicsLayerLayout,
  GraphicsRect,
  GraphicsQrLayout,
  GraphicsScrimLayout,
  GraphicsTextItemLayout,
  GraphicsTextLayout,
} from "../../graphics/layout.js";
import { layoutGraphics } from "../../graphics/layout.js";
import type {
  GraphicsDocument,
  GraphicsFrame,
  GraphicsLayer,
  GraphicsQrLayer,
  GraphicsScrimLayer,
  GraphicsTextItem,
  GraphicsTextLayer,
} from "../../graphics/model.js";
import { qrMatrix } from "../../graphics/qr.js";
import type { GraphicsStillGroup } from "../../graphics/stills.js";
import { graphicsStillGroups } from "../../graphics/stills.js";
import { groupMotionAt } from "../../graphics/timing.js";
import type { CaptionFontUrls } from "../captions/caption-fonts.js";
import { measureCaptionText, useBundledFonts } from "../captions/caption-fonts.js";

export type GraphicsOverlayImage = { src: string; width: number; height: number };

type GraphicsOverlayInput = {
  document: GraphicsDocument;
  frame: GraphicsFrame;
  durationSeconds: number;
  images: Readonly<Record<string, GraphicsOverlayImage>>;
  fontUrls: CaptionFontUrls;
  onLayout?: (layout: GraphicsLayerLayout[]) => void;
};

export type GraphicsOverlayProps = GraphicsOverlayInput & { seconds?: number; groupIndex?: number };

export interface GraphicsStillProps extends Record<string, unknown> {
  document: GraphicsDocument;
  frame: GraphicsFrame;
  durationSeconds: number;
  images: Record<string, GraphicsOverlayImage>;
  fontUrls: CaptionFontUrls;
  groupIndex: number;
  seconds?: number;
}

const OUTLINE_COLOR = "#000000";
const OUTLINE_WIDTH = 0.08;
const BORDER_COLOR = "#FFFFFF";
const BORDER_OPACITY = 0.55;
const BORDER_WIDTH = 0.023;
const BRUSH_VIEWBOX = "0 0 100 20";
const BRUSH_PATH = "M1 13C18 6 39 4 62 6c13 1 25 3 37 1-9 6-24 9-41 9-17 0-32-2-46 2-5 2-9 0-11-5Z";

function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function textStyle(item: GraphicsTextItem, layout: GraphicsTextItemLayout): React.CSSProperties {
  const size = layout.font.size;
  return {
    fontFamily: layout.font.family,
    fontWeight: layout.font.weight,
    fontSize: size,
    whiteSpace: "pre",
    filter: item.shadow ? `drop-shadow(0 ${size * 0.05}px ${size * 0.28}px rgba(0, 0, 0, 0.55))` : undefined,
  };
}

const TextItemView: React.FC<{ item: GraphicsTextItem; layout: GraphicsTextItemLayout; visibleWords: number }> = ({ item, layout, visibleWords }) => (
  <>
    {visibleWords > 0 && item.icon && layout.icon ? (
      <svg x={layout.icon.x} y={layout.icon.y} width={layout.icon.width} height={layout.icon.height} viewBox={`0 0 ${GRAPHICS_ICON_VIEWBOX} ${GRAPHICS_ICON_VIEWBOX}`}>
        <path d={GRAPHICS_ICON_PATHS[item.icon]} fill={item.color} />
      </svg>
    ) : null}
    {layout.lines.map((line, index) => (
      <text
        key={index}
        x={line.x}
        y={line.baseline}
        fill={item.color}
        stroke={item.outline ? OUTLINE_COLOR : undefined}
        strokeWidth={item.outline ? layout.font.size * OUTLINE_WIDTH : undefined}
        strokeLinejoin="round"
        paintOrder="stroke"
        style={textStyle(item, layout)}
      >
        {visibleWords >= layout.words.length ? line.text : line.text.slice(0, Math.max(0, ...layout.words.slice(0, visibleWords).filter((word) => word.lineIndex === index).map((word) => word.end)))}
      </text>
    ))}
    {visibleWords >= layout.words.length && layout.accent && item.accent === "underline" ? (
      <rect x={layout.accent.x} y={layout.accent.y} width={layout.accent.width} height={layout.accent.height} rx={layout.accent.height / 2} fill={item.color} />
    ) : null}
    {visibleWords >= layout.words.length && layout.accent && item.accent === "brush" ? (
      <svg x={layout.accent.x} y={layout.accent.y} width={layout.accent.width} height={layout.accent.height} viewBox={BRUSH_VIEWBOX} preserveAspectRatio="none">
        <path d={BRUSH_PATH} fill={item.color} />
      </svg>
    ) : null}
  </>
);

const TextLayerView: React.FC<{ layer: GraphicsTextLayer; layout: GraphicsTextLayout; frame: GraphicsFrame; reveal: number }> = ({ layer, layout, frame, reveal }) => {
  const wordCount = layout.items.reduce((sum, item) => sum + item.words.length, 0);
  const visibleWords = Math.ceil(wordCount * reveal);
  const plate = layer.plate && layout.plate ? { style: layer.plate, box: layout.plate } : null;
  const border = plate?.style.border ? Math.max(1, plate.box.height * BORDER_WIDTH) : 0;
  return (
    <svg width={frame.width} height={frame.height} style={{ position: "absolute", left: 0, top: 0, overflow: "visible", opacity: layer.opacity }}>
      {plate ? (
        <rect
          x={plate.box.x + border / 2}
          y={plate.box.y + border / 2}
          width={Math.max(0, plate.box.width - border)}
          height={Math.max(0, plate.box.height - border)}
          rx={Math.max(0, plate.box.radius - border / 2)}
          fill={plate.style.color}
          fillOpacity={plate.style.opacity}
          stroke={border > 0 ? BORDER_COLOR : undefined}
          strokeOpacity={BORDER_OPACITY}
          strokeWidth={border > 0 ? border : undefined}
        />
      ) : null}
      {layout.items.map((itemLayout, index) => {
        const item = layer.items.find((candidate) => candidate.id === itemLayout.itemId);
        return item ? <TextItemView key={item.id} item={item} layout={itemLayout} visibleWords={Math.max(0, visibleWords - layout.items.slice(0, index).reduce((sum, entry) => sum + entry.words.length, 0))} /> : null;
      })}
    </svg>
  );
};

function moduleRuns(size: number, dark: readonly boolean[]): string {
  const runs: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let column = 0;
    while (column < size) {
      if (!dark[row * size + column]) {
        column += 1;
        continue;
      }
      const start = column;
      while (column < size && dark[row * size + column]) column += 1;
      runs.push(`M${start} ${row}h${column - start}v1h${start - column}Z`);
    }
  }
  return runs.join("");
}

const QrLayerView: React.FC<{ layer: GraphicsQrLayer; layout: GraphicsQrLayout; frame: GraphicsFrame }> = ({ layer, layout, frame }) => {
  const matrix = useMemo(() => (layer.url ? qrMatrix(layer.url, layer.level) : null), [layer.url, layer.level]);
  if (!matrix) return null;
  const backing = layout.tile ?? { ...layout.modules, radius: 0 };
  return (
    <svg width={frame.width} height={frame.height} style={{ position: "absolute", left: 0, top: 0, opacity: layer.opacity }}>
      <rect x={backing.x} y={backing.y} width={backing.width} height={backing.height} rx={backing.radius} fill={layer.light} />
      <svg x={layout.modules.x} y={layout.modules.y} width={layout.modules.width} height={layout.modules.height} viewBox={`0 0 ${matrix.size} ${matrix.size}`} shapeRendering="crispEdges">
        <path d={moduleRuns(matrix.size, matrix.dark)} fill={layer.dark} />
      </svg>
    </svg>
  );
};

const ScrimLayerView: React.FC<{ layer: GraphicsScrimLayer; layout: GraphicsScrimLayout }> = ({ layer, layout }) => (
  <div
    style={{
      position: "absolute",
      left: layout.box.x,
      top: layout.box.y,
      width: layout.box.width,
      height: layout.box.height,
      opacity: layer.opacity,
      background: `linear-gradient(to ${layer.edge === "bottom" ? "top" : "bottom"}, ${rgba(layer.color, layer.strength)}, ${rgba(layer.color, 0)})`,
    }}
  />
);

const ImageLayerView: React.FC<{ layer: GraphicsLayer; layout: GraphicsImageLayout; image: GraphicsOverlayImage | undefined }> = ({ layer, layout, image }) => {
  if (!image || layout.missing) return null;
  return (
    <Img
      src={image.src}
      style={{ position: "absolute", left: layout.box.x, top: layout.box.y, width: layout.box.width, height: layout.box.height, opacity: layer.opacity }}
    />
  );
};

const LayerView: React.FC<{
  layer: GraphicsLayer;
  layout: GraphicsLayerLayout;
  frame: GraphicsFrame;
  images: Readonly<Record<string, GraphicsOverlayImage>>;
  reveal: number;
}> = ({ layer, layout, frame, images, reveal }) => {
  if (layer.kind === "text" && layout.kind === "text") return <TextLayerView layer={layer} layout={layout} frame={frame} reveal={reveal} />;
  if (layer.kind === "qr" && layout.kind === "qr") return <QrLayerView layer={layer} layout={layout} frame={frame} />;
  if (layer.kind === "scrim" && layout.kind === "scrim") return <ScrimLayerView layer={layer} layout={layout} />;
  if (layer.kind === "image" && layout.kind === "image") return <ImageLayerView layer={layer} layout={layout} image={images[layer.artifactId]} />;
  return null;
};

function groupBox(group: GraphicsStillGroup, boxes: ReadonlyMap<string, GraphicsLayerLayout>): GraphicsRect {
  const rects = group.layerIds.flatMap((id) => boxes.get(id)?.box ?? []);
  const x = Math.min(...rects.map((box) => box.x));
  const y = Math.min(...rects.map((box) => box.y));
  return { x, y, width: Math.max(...rects.map((box) => box.x + box.width)) - x, height: Math.max(...rects.map((box) => box.y + box.height)) - y };
}

export const GraphicsOverlay: React.FC<GraphicsOverlayProps> = ({ document, frame, durationSeconds, images, fontUrls, onLayout, seconds, groupIndex }) => {
  const ready = useBundledFonts(fontUrls);
  const layout = useMemo(
    () => (ready ? layoutGraphics({ document, frame, images, measure: (text, font) => measureCaptionText(text, font, font.family) }) : null),
    [ready, document, frame, images],
  );
  const groups = useMemo(() => graphicsStillGroups(document, durationSeconds), [document, durationSeconds]);
  useEffect(() => {
    if (layout && onLayout) onLayout(layout);
  }, [layout, onLayout]);
  if (!layout) return null;
  const layers = new Map(document.layers.map((layer) => [layer.id, layer]));
  const boxes = new Map(layout.map((entry) => [entry.layerId, entry]));
  const shown = groupIndex === undefined ? groups : groups.slice(groupIndex, groupIndex + 1);
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {shown.map((group) => {
        const box = groupBox(group, boxes);
        const motion = groupMotionAt(seconds === undefined ? { ...group.timing, fadeIn: 0, fadeOut: 0 } : group.timing, seconds ?? group.timing.start, { ...box, frameWidth: frame.width, frameHeight: frame.height });
        return <AbsoluteFill key={group.layerIds.join(" ")} style={{ opacity: motion.opacity, transform: motion.dx !== 0 || motion.dy !== 0 || motion.scale !== 1 ? `translate(${motion.dx}px, ${motion.dy}px) scale(${motion.scale})` : undefined, transformOrigin: motion.scale !== 1 ? `${box.x + box.width / 2}px ${box.y + box.height / 2}px` : undefined }}>
          {group.layerIds.map((layerId) => {
            const layer = layers.get(layerId);
            const box = boxes.get(layerId);
            return layer && box ? <LayerView key={layerId} layer={layer} layout={box} frame={frame} images={images} reveal={motion.reveal} /> : null;
          })}
        </AbsoluteFill>;
      })}
    </AbsoluteFill>
  );
};
