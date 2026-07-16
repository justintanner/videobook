import React from "react";
import {
  AbsoluteFill,
  Img,
  Audio,
  Sequence,
  interpolate,
  useCurrentFrame,
} from "remotion";
import {
  buildOutroSpec,
  cardAnimationProgress,
  cardEntryOffset,
  cueWindows,
  PANEL_BG,
  CARD_PAD,
  CARD_SHADOW,
  CARD_RADIUS,
} from "./qr-outro-spec.js";
import type { AspectRatio } from "./qr-outro-spec.js";

export interface QrOutroInputProps extends Record<string, unknown> {
  frameSrc: string;
  qrSrcs: string[];
  audioSrc: string | null;
  aspectRatio: AspectRatio;
}

const BlurFillImage: React.FC<{
  src: string;
  rect: { x: number; y: number; w: number; h: number };
}> = ({ src, rect }) => (
  <div
    style={{
      position: "absolute",
      left: rect.x,
      top: rect.y,
      width: rect.w,
      height: rect.h,
      overflow: "hidden",
    }}
  >
    <Img
      src={src}
      style={{
        position: "absolute",
        width: "100%",
        height: "100%",
        objectFit: "cover",
        filter: "blur(20px) brightness(0.4)",
        transform: "scale(1.15)",
      }}
    />
    <Img
      src={src}
      style={{
        position: "absolute",
        width: "100%",
        height: "100%",
        objectFit: "contain",
      }}
    />
  </div>
);

const QrCard: React.FC<{
  src: string;
  placement: { x: number; y: number; w: number; h: number };
  impactFrame: number;
  cardIndex: number;
  entryOffset: { x: number; y: number };
}> = ({ src, placement, impactFrame, cardIndex, entryOffset }) => {
  const frame = useCurrentFrame();
  const anim = cardAnimationProgress(frame, impactFrame);

  if (!anim.visible) return null;

  const enterDir = cardIndex % 2 === 0 ? -1 : 1;
  const translateX = anim.translateFraction * entryOffset.x;
  const translateY = anim.translateFraction * entryOffset.y;

  return (
    <div
      style={{
        position: "absolute",
        left: placement.x,
        top: placement.y,
        width: placement.w,
        height: placement.h,
        opacity: anim.opacity,
        transform: `translate(${translateX}px, ${translateY}px) rotate(${anim.rotation * enterDir}deg) scale(${anim.scale})`,
        transformOrigin: "center center",
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: CARD_RADIUS,
          backgroundColor: "#FFFFFF",
          boxShadow: CARD_SHADOW,
          padding: CARD_PAD,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Img
          src={src}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            imageRendering: "pixelated",
          }}
        />
      </div>
    </div>
  );
};

export const QrOutroComposition: React.FC<QrOutroInputProps> = ({
  frameSrc,
  qrSrcs,
  audioSrc,
  aspectRatio,
}) => {
  const spec = buildOutroSpec(aspectRatio, qrSrcs.length);
  const windows = audioSrc
    ? cueWindows(qrSrcs.length, spec.totalDurationFrames)
    : [];

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      <BlurFillImage src={frameSrc} rect={spec.layout.frameRect} />

      <div
        style={{
          position: "absolute",
          left: spec.layout.panelRect.x,
          top: spec.layout.panelRect.y,
          width: spec.layout.panelRect.w,
          height: spec.layout.panelRect.h,
          backgroundColor: PANEL_BG,
        }}
      />

      {spec.cards.map((card, i) => (
        <QrCard
          key={i}
          src={qrSrcs[i]}
          placement={card}
          impactFrame={spec.impacts[i].frame}
          cardIndex={i}
          entryOffset={cardEntryOffset(card, spec.layout)}
        />
      ))}

      {audioSrc && windows.map((cue, i) => {
        const cueDuration = cue.endFrame - cue.startFrame;
        const fadeDuration = Math.min(3, Math.floor(cueDuration / 3));
        return (
          <Sequence
            key={`sfx-${i}`}
            from={cue.startFrame}
            durationInFrames={cueDuration}
          >
            <Audio
              src={audioSrc}
              endAt={cueDuration}
              volume={(localFrame: number) => {
                if (localFrame < cueDuration - fadeDuration) return 1;
                return interpolate(
                  localFrame,
                  [cueDuration - fadeDuration, cueDuration - 1],
                  [1, 0],
                  { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
                );
              }}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
