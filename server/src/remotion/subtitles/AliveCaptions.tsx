import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Anton";
import type { AliveColumn, AliveCue, AliveSettings, AliveTimedWord } from "./alive-types.js";
import {
  ALIVE_LINE_HEIGHT,
  activeCue,
  cueFade,
  fitPunch,
  lineGap,
  punchWord,
  wordLook,
} from "./alive-layout.js";

const { fontFamily } = loadFont();

export interface AliveCaptionsProps {
  cues: AliveCue[];
  settings: AliveSettings;
  strokeWidth: number;
  strokeColor: string;
  shadowBlur: number;
  shadowOpacity: number;
}

interface TextFinish {
  strokeWidth: number;
  strokeColor: string;
  shadowBlur: number;
  shadowOpacity: number;
}

interface AliveLineProps {
  words: AliveTimedWord[];
  fontSize: number;
  time: number;
  fade: number;
  settings: AliveSettings;
  side: AliveColumn["side"];
  finish: TextFinish;
  last: boolean;
}

function justifyFor(side: AliveColumn["side"]): "flex-start" | "flex-end" | "center" {
  if (side === "left") return "flex-start";
  if (side === "right") return "flex-end";
  return "center";
}

function originFor(side: AliveColumn["side"]): string {
  if (side === "left") return "left bottom";
  if (side === "right") return "right bottom";
  return "center bottom";
}

function textShadow(finish: TextFinish, fontSize: number): string {
  const glow = `0 ${Math.round(fontSize * 0.04)}px ${Math.round(fontSize * 0.3)}px rgba(0,0,0,0.5)`;
  if (finish.shadowBlur <= 0) return glow;
  const offset = Math.round(finish.shadowBlur / 2);
  return `${offset}px ${offset}px ${finish.shadowBlur}px rgba(0,0,0,${finish.shadowOpacity / 100}), ${glow}`;
}

const AliveLine: React.FC<AliveLineProps> = ({ words, fontSize, time, fade, settings, side, finish, last }) => {
  const stroke = Math.min(finish.strokeWidth, fontSize * 0.035);
  return (
    <div
      style={{
        display: "flex",
        justifyContent: justifyFor(side),
        gap: Math.round(fontSize * 0.2),
        fontSize,
        lineHeight: ALIVE_LINE_HEIGHT,
        height: fontSize * ALIVE_LINE_HEIGHT,
        marginBottom: last ? 0 : lineGap(fontSize),
        whiteSpace: "nowrap",
      }}
    >
      {words.map((word, index) => {
        const look = wordLook(word, time, settings, fontSize, fade);
        return (
          <span
            key={`${word.start}-${index}`}
            style={{
              display: "inline-block",
              opacity: look.opacity,
              color: look.color,
              transform: `translateY(${look.translateY}px) scale(${look.scale})`,
              transformOrigin: originFor(side),
              WebkitTextStroke: stroke > 0 ? `${stroke}px ${finish.strokeColor}` : undefined,
              paintOrder: stroke > 0 ? "stroke fill" : undefined,
              textShadow: textShadow(finish, fontSize),
            }}
          >
            {word.text.toUpperCase()}
          </span>
        );
      })}
    </div>
  );
};

function blockStyle(column: AliveColumn, top: number): React.CSSProperties {
  return {
    position: "absolute",
    left: column.x,
    top,
    width: column.width,
    display: "flex",
    flexDirection: "column",
    fontFamily,
    fontWeight: 400,
    userSelect: "none",
    pointerEvents: "none",
  };
}

export const AliveCaptions: React.FC<AliveCaptionsProps> = ({ cues, settings, ...finish }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const time = frame / fps;
  const cue = activeCue(cues, time);
  if (!cue) return null;
  const fade = cueFade(cue, time);

  if (settings.style === "punch") {
    const word = punchWord(cue, time);
    if (!word) return null;
    const fontSize = fitPunch(word, cue.column, settings.energySizing);
    const top = cue.column.y + (cue.column.height - fontSize * ALIVE_LINE_HEIGHT) / 2;
    return (
      <div style={blockStyle(cue.column, top)}>
        <AliveLine words={[word]} fontSize={fontSize} time={time} fade={fade} settings={settings} side={cue.column.side} finish={finish} last />
      </div>
    );
  }

  return (
    <div style={blockStyle(cue.column, cue.blockTop)}>
      {cue.lines.map((line, index) => (
        <AliveLine
          key={`${cue.id}-${index}`}
          words={line.words}
          fontSize={line.fontSize}
          time={time}
          fade={fade}
          settings={settings}
          side={cue.column.side}
          finish={finish}
          last={index === cue.lines.length - 1}
        />
      ))}
    </div>
  );
};
