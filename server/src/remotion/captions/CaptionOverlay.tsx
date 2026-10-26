import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { captionPresetFont } from "../../captions/fonts.js";
import type { CaptionBlock, CaptionLayoutLine, CaptionRegionFrame } from "../../captions/layout.js";
import { activeCaptionBlock } from "../../captions/layout.js";
import type { CaptionDocument } from "../../captions/model.js";
import { captionWordLook, cueVisibility, energyScale, punchWord } from "../../captions/motion.js";
import { isUnspacedText } from "../../captions/script.js";
import type { CaptionFontUrls } from "./caption-fonts.js";
import { useCaptionLayout } from "./caption-layout.js";

export interface CaptionOverlayProps {
  document: CaptionDocument;
  regions: readonly CaptionRegionFrame[];
  fontUrls: CaptionFontUrls;
}

function textShadow(enabled: boolean, fontSize: number): string | undefined {
  if (!enabled) return undefined;
  return `0 ${Math.round(fontSize * 0.05)}px ${Math.round(fontSize * 0.28)}px rgba(0,0,0,0.55)`;
}

function tightBefore(line: CaptionLayoutLine, index: number): boolean {
  if (index === 0) return true;
  return isUnspacedText(line.words[index - 1].display.at(-1) ?? "") && isUnspacedText(line.words[index].display.charAt(0));
}

interface LineProps {
  line: CaptionLayoutLine;
  block: CaptionBlock;
  document: CaptionDocument;
  time: number;
  first: boolean;
}

const CaptionLine: React.FC<LineProps> = ({ line, block, document, time, first }) => {
  const style = document.style;
  const stroke = (style.outlineWidth * block.fontSize) / 80;
  const measured = document.wordTiming === "measured";
  const scale = energyScale(line.words, style);
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        height: block.lineHeight,
        marginTop: first ? 0 : block.gap,
        whiteSpace: "nowrap",
        transform: scale === 1 ? undefined : `scale(${scale})`,
      }}
    >
      {line.words.map((word, index) => {
        const look = captionWordLook(word, time, style, block.fontSize, measured);
        return (
          <span
            key={word.id}
            style={{
              display: "inline-block",
              marginInlineStart: tightBefore(line, index) ? 0 : block.space,
              opacity: look.opacity,
              color: look.highlighted ? style.highlightColor : style.textColor,
              transform: `translateY(${look.translateY}px) scale(${look.scale})`,
              transformOrigin: "center bottom",
              WebkitTextStroke: stroke > 0 ? `${stroke}px ${style.outlineColor}` : undefined,
              paintOrder: stroke > 0 ? "stroke fill" : undefined,
              textShadow: textShadow(style.shadow, block.fontSize),
            }}
          >
            {word.display}
          </span>
        );
      })}
    </div>
  );
};

function visibleLines(block: CaptionBlock, document: CaptionDocument, time: number): CaptionLayoutLine[] {
  if (document.style.preset !== "punch") return block.lines;
  const word = punchWord(block.cue, time);
  const line = word ? block.lines.find((candidate) => candidate.words[0]?.id === word.id) : undefined;
  return line ? [line] : [];
}

export const CaptionBlockView: React.FC<{ block: CaptionBlock; document: CaptionDocument; stack: string; time: number }> = ({ block, document, stack, time }) => {
  const visibility = cueVisibility(block.cue, time, block.fontSize);
  const face = captionPresetFont(document.style.preset);
  const lines = visibleLines(block, document, time);
  return (
    <div
      style={{
        position: "absolute",
        left: block.x,
        top: block.y,
        width: block.width,
        height: block.height,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity: visibility.opacity,
        transform: `translateY(${visibility.translateY}px)`,
        direction: block.direction,
        fontFamily: stack,
        fontWeight: face.weight,
        fontSize: block.fontSize,
        lineHeight: `${block.lineHeight}px`,
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      {lines.map((line, index) => (
        <CaptionLine key={line.words[0]?.id ?? index} line={line} block={block} document={document} time={time} first={index === 0} />
      ))}
    </div>
  );
};

export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({ document, regions, fontUrls }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const layout = useCaptionLayout(document, regions, fontUrls);
  const time = frame / fps;
  const block = activeCaptionBlock(layout.blocks, time);
  if (!block) return null;
  return <CaptionBlockView block={block} document={document} stack={layout.stack} time={time} />;
};
