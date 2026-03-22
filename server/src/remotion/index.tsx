import React from "react";
import { Composition, registerRoot } from "remotion";
import { RenderComposition } from "./RenderComposition.js";
import type { RenderInputProps } from "./subtitles/types.js";

const defaultProps: RenderInputProps = {
  videoSrc: "",
  targetWidth: 1920,
  targetHeight: 1080,
  sourceWidth: 1920,
  sourceHeight: 1080,
  durationInFrames: 300,
  fps: 30,
  subtitlesEnabled: false,
  chunks: [],
  style: "impact",
  position: "bottom",
  fontSize: "medium",
  textColor: "#F8FAFC",
  highlightColor: "#991B1B",
  audioFadeIn: 150,
  audioFadeOut: 100,
  audioVolume: 100,
  osgSrc: null,
  osgPosition: "top-right",
  backgroundMode: "blur",
};

// eslint-disable-next-line react-refresh/only-export-components
const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="render"
        component={RenderComposition as React.FC<Record<string, unknown>>}
        durationInFrames={defaultProps.durationInFrames}
        fps={defaultProps.fps}
        width={defaultProps.targetWidth}
        height={defaultProps.targetHeight}
        defaultProps={defaultProps}
        calculateMetadata={({ props }) => ({
          durationInFrames: (props as RenderInputProps).durationInFrames,
          fps: (props as RenderInputProps).fps,
          width: (props as RenderInputProps).targetWidth,
          height: (props as RenderInputProps).targetHeight,
        })}
      />
    </>
  );
};

registerRoot(RemotionRoot);
