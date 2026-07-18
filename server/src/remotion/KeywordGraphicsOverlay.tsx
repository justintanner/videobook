import React from "react";
import { Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/PlayfairDisplay";
import type { KeywordGraphic } from "./subtitles/types.js";
import { keywordFontSize, keywordLayout } from "./keyword-placement.js";

const { fontFamily } = loadFont("normal", {
  weights: ["700"],
  subsets: ["latin", "latin-ext", "cyrillic", "vietnamese"],
});

interface KeywordGraphicsOverlayProps {
  graphics: KeywordGraphic[];
}

export const KeywordGraphicsOverlay: React.FC<KeywordGraphicsOverlayProps> = ({ graphics }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const currentTime = frame / fps;
  const active = graphics.find((graphic) => currentTime >= graphic.start && currentTime < graphic.end);
  if (!active) return null;

  const span = Math.max(0.01, active.end - active.start);
  const enterEnd = active.start + Math.min(0.5, span * 0.35);
  const exitStart = Math.max(enterEnd, active.end - Math.min(0.38, span * 0.25));
  const reveal = interpolate(currentTime, [active.start, enterEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const fade = interpolate(currentTime, [exitStart, active.end], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.quad),
  });
  const portrait = height > width;
  const smartLayout = active.anchor
    ? keywordLayout(active.text, active.anchor, width, height, active.scale ?? 1)
    : null;
  const side = smartLayout?.side ?? active.side;
  const direction = side === "right" ? 1 : -1;
  const fontSize = smartLayout?.fontSize ?? keywordFontSize(active.text, width, height);
  const sideInset = smartLayout?.sideInset ?? Math.round(width * (portrait ? 0.065 : 0.07));
  const lineWidth = interpolate(reveal, [0, 1], [0, Math.min(width * 0.14, fontSize * 2.25)]);

  return (
    <div
      style={{
        position: "absolute",
        top: smartLayout?.top ?? (portrait ? "25%" : "29%"),
        ...(side === "right" ? { right: sideInset } : { left: sideInset }),
        width: smartLayout?.containerWidth ?? (portrait ? "72%" : "43%"),
        display: "flex",
        flexDirection: "column",
        alignItems: side === "right" ? "flex-end" : "flex-start",
        opacity: reveal * fade,
        transform: `translate3d(${direction * (1 - reveal) * 56}px, ${(1 - reveal) * 12}px, 0) scale(${0.97 + reveal * 0.03})`,
        filter: `blur(${(1 - reveal) * 5}px)`,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          color: "#FFFFFF",
          fontFamily,
          fontSize,
          fontWeight: 700,
          lineHeight: 0.94,
          letterSpacing: `${0.13 - reveal * 0.07}em`,
          textAlign: side === "right" ? "right" : "left",
          textShadow: "0 4px 22px rgba(0,0,0,0.9), 0 1px 4px rgba(0,0,0,1)",
          textTransform: "uppercase",
          overflowWrap: "anywhere",
        }}
      >
        {active.text}
      </div>
      <div
        style={{
          width: lineWidth,
          height: Math.max(2, Math.round(width * 0.002)),
          marginTop: Math.round(fontSize * 0.2),
          backgroundColor: "rgba(255,255,255,0.92)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.75)",
        }}
      />
    </div>
  );
};
