import React from "react";
import {
  AbsoluteFill,
  Img,
  Audio,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import {
  buildOutroSpec,
  cardAnimationProgress,
  cardEntryOffset,
  cueWindows,
  BACKGROUND_COLOR,
} from "./qr-outro-spec.js";
import type { AspectRatio } from "./qr-outro-spec.js";
import { DEFAULT_QR_OUTRO_SOUND_FILENAME } from "./qr-outro-audio.js";

export interface QrOutroInputProps extends Record<string, unknown> {
  qrSrcs: string[];
  audioSrc: string | null;
  aspectRatio: AspectRatio;
}

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
      <Img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          objectFit: "contain",
          imageRendering: "pixelated",
        }}
      />
    </div>
  );
};

export const QrOutroComposition: React.FC<QrOutroInputProps> = ({
  qrSrcs,
  audioSrc,
  aspectRatio,
}) => {
  const spec = buildOutroSpec(aspectRatio, qrSrcs.length);
  const resolvedAudioSrc = audioSrc ?? staticFile(DEFAULT_QR_OUTRO_SOUND_FILENAME);
  const windows = cueWindows(qrSrcs.length, spec.totalDurationFrames);

  return (
    <AbsoluteFill style={{ backgroundColor: BACKGROUND_COLOR }}>
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

      {windows.map((cue, i) => {
        const cueDuration = cue.endFrame - cue.startFrame;
        const fadeDuration = Math.min(3, Math.floor(cueDuration / 3));
        return (
          <Sequence
            key={`sfx-${i}`}
            from={cue.startFrame}
            durationInFrames={cueDuration}
          >
            <Audio
              src={resolvedAudioSrc}
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
