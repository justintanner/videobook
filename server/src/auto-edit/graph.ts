import { AUDIO_OPTS, H264_MEDIUM } from "../ffmpeg.js";
import { lookFilter } from "./looks.js";
import {
  checkSegmentPlan,
  segmentOutputFrames,
  type PlanSegment,
  type SegmentPlan,
  type SegmentZoom,
} from "./plan.js";

const AUDIO_SAMPLE_RATE = 48_000;
const SEGMENT_FADE_SECONDS = 0.005;
const ATEMPO_MIN = 0.5;
const ATEMPO_MAX = 2;

export interface SegmentRenderArgsOptions {
  inputPath: string;
  outputPath: string;
  variableFrameRate: boolean;
}

export interface SegmentFilterGraph {
  inputArgs: string[];
  filterParts: string[];
  videoOut: string;
  audioOut: string | null;
}

function filterNumber(value: number): string {
  return Number(value.toFixed(12)).toString();
}

function seekNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function atempoChain(speed: number): string[] {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining < ATEMPO_MIN) {
    filters.push(`atempo=${ATEMPO_MIN}`);
    remaining /= ATEMPO_MIN;
  }
  while (remaining > ATEMPO_MAX) {
    filters.push(`atempo=${ATEMPO_MAX}`);
    remaining /= ATEMPO_MAX;
  }
  filters.push(`atempo=${filterNumber(remaining)}`);
  return filters;
}

function lerpExpression(fromValue: number, toValue: number, weightExpr: string): string {
  const delta = toValue - fromValue;
  if (Math.abs(delta) < 1e-12) return filterNumber(fromValue);
  const sign = delta >= 0 ? "+" : "-";
  return `(${filterNumber(fromValue)}${sign}${filterNumber(Math.abs(delta))}*${weightExpr})`;
}

function buildSegmentZoomFilter(zoom: SegmentZoom | undefined, outputFrames: number): string | null {
  if (!zoom) return null;
  if (zoom.from.scale === 1 && zoom.to.scale === 1) return null;
  if (zoom.ease === "hold") {
    if (zoom.to.scale === 1) return null;
    const z = filterNumber(zoom.to.scale);
    const left = `(${filterNumber(zoom.to.x)}*W-0.5)*(1-1/${z})`;
    const top = `(${filterNumber(zoom.to.y)}*H-0.5)*(1-1/${z})`;
    const right = `${left}+W/${z}`;
    const bottom = `${top}+H/${z}`;
    return [
      `perspective=x0='${left}'`,
      `y0='${top}'`,
      `x1='${right}'`,
      `y1='${top}'`,
      `x2='${left}'`,
      `y2='${bottom}'`,
      `x3='${right}'`,
      `y3='${bottom}'`,
      "sense=source",
      "interpolation=cubic",
      "eval=frame",
    ].join(":");
  }
  const rampFraction = zoom.rampFraction ?? 1;
  const span = filterNumber(Math.max(1e-6, (outputFrames - 1) * rampFraction));
  const uSetup = `st(0,clip((in-1)/${span},0,1));`;
  const weightSetup = zoom.ease === "smooth" ? `${uSetup}st(1,ld(0)*ld(0)*(3-2*ld(0)));` : uSetup;
  const weightReg = zoom.ease === "smooth" ? "ld(1)" : "ld(0)";
  const scaleSetup = `${weightSetup}st(2,${lerpExpression(zoom.from.scale, zoom.to.scale, weightReg)});`;
  const fx = lerpExpression(zoom.from.x, zoom.to.x, weightReg);
  const fy = lerpExpression(zoom.from.y, zoom.to.y, weightReg);
  const left = `(${fx}*W-0.5)*(1-1/ld(2))`;
  const top = `(${fy}*H-0.5)*(1-1/ld(2))`;
  const right = `${left}+W/ld(2)`;
  const bottom = `${top}+H/ld(2)`;
  const corner = (expression: string): string => `'${scaleSetup}${expression}'`;
  return [
    `perspective=x0=${corner(left)}`,
    `y0=${corner(top)}`,
    `x1=${corner(right)}`,
    `y1=${corner(top)}`,
    `x2=${corner(left)}`,
    `y2=${corner(bottom)}`,
    `x3=${corner(right)}`,
    `y3=${corner(bottom)}`,
    "sense=source",
    "interpolation=cubic",
    "eval=frame",
  ].join(":");
}

export function segmentPictureFilters(
  segment: PlanSegment,
  fps: number,
  options: { variableFrameRate: boolean; width?: number },
): string[] {
  const fpsStr = filterNumber(fps);
  const outputFrames = segmentOutputFrames(segment);
  const filters: string[] = ["setpts=PTS-STARTPTS"];
  if (options.variableFrameRate) {
    filters.push(`fps=fps=${fpsStr}`);
  }
  if (segment.speed < 1) {
    const interpFps = filterNumber(fps / segment.speed);
    if (segment.motion === "flow") {
      filters.push(`minterpolate=fps=${interpFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`);
    } else if (segment.motion === "blend") {
      filters.push(`minterpolate=fps=${interpFps}:mi_mode=blend`);
    }
  }
  if (segment.speed !== 1) {
    filters.push(`setpts=PTS/${filterNumber(segment.speed)}`);
  }
  filters.push(`fps=${fpsStr}`);
  filters.push(`trim=end_frame=${outputFrames}`);
  const zoomFilter = buildSegmentZoomFilter(segment.zoom, outputFrames);
  if (zoomFilter) {
    filters.push(zoomFilter);
  }
  const look = segment.look ?? "none";
  if (look !== "none") {
    if (options.width === undefined) {
      throw new Error(`Segment "${segment.id}" requires source width for look "${look}".`);
    }
    const lookChain = lookFilter(look, options.width);
    if (lookChain) {
      filters.push(lookChain);
    }
  }
  filters.push("format=yuv420p", "setsar=1");
  return filters;
}

function segmentAudioChain(segment: PlanSegment, index: number, fps: number): string {
  const outputDuration = segmentOutputFrames(segment) / fps;
  const durationStr = filterNumber(outputDuration);
  if (segment.audio === "mute") {
    return `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SAMPLE_RATE},atrim=duration=${durationStr},asetpts=PTS-STARTPTS[a${index}]`;
  }
  const fade = Math.min(SEGMENT_FADE_SECONDS, outputDuration / 4);
  const fadeStr = filterNumber(fade);
  const fadeOutStart = filterNumber(Math.max(0, outputDuration - fade));
  const chain: string[] = [
    `[${index}:a:0]aresample=${AUDIO_SAMPLE_RATE}`,
    "aformat=sample_fmts=fltp:channel_layouts=stereo",
  ];
  if (segment.startFrame > 0) {
    chain.push(`atrim=start=${filterNumber(0.5 / fps)}`);
  }
  chain.push("asetpts=PTS-STARTPTS");
  if (segment.speed !== 1) {
    if (segment.audio === "pitch") {
      chain.push(`asetrate=${filterNumber(AUDIO_SAMPLE_RATE * segment.speed)}`, `aresample=${AUDIO_SAMPLE_RATE}`);
    } else {
      chain.push(...atempoChain(segment.speed));
    }
  }
  chain.push(
    `apad=whole_dur=${durationStr}`,
    `atrim=duration=${durationStr}`,
    "asetpts=PTS-STARTPTS",
    `afade=t=in:st=0:d=${fadeStr}`,
    `afade=t=out:st=${fadeOutStart}:d=${fadeStr}`,
  );
  return `${chain.join(",")}[a${index}]`;
}

export function buildSegmentFilterGraph(
  plan: SegmentPlan,
  options: { inputPath: string; variableFrameRate: boolean },
): SegmentFilterGraph {
  const issues = checkSegmentPlan(plan);
  if (issues.length > 0) {
    throw new Error(issues[0]!.message);
  }
  const fps = plan.source.fps;
  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  plan.segments.forEach((segment, index) => {
    const sourceFrames = segment.endFrame - segment.startFrame;
    const readFrames = options.variableFrameRate ? sourceFrames + 2 : sourceFrames + 1;
    if (segment.startFrame > 0) {
      inputArgs.push("-ss", seekNumber((segment.startFrame - 0.5) / fps));
    }
    inputArgs.push("-t", seekNumber(readFrames / fps), "-i", options.inputPath);

    const videoFilters = segmentPictureFilters(segment, fps, {
      variableFrameRate: options.variableFrameRate,
      width: plan.source.width,
    });
    filterParts.push(`[${index}:v:0]${videoFilters.join(",")}[v${index}]`);

    if (plan.source.hasAudio) {
      filterParts.push(segmentAudioChain(segment, index, fps));
      concatInputs.push(`[v${index}][a${index}]`);
    } else {
      concatInputs.push(`[v${index}]`);
    }
  });

  if (plan.source.hasAudio) {
    filterParts.push(`${concatInputs.join("")}concat=n=${plan.segments.length}:v=1:a=1[vout][aout]`);
  } else {
    filterParts.push(`${concatInputs.join("")}concat=n=${plan.segments.length}:v=1:a=0[vout]`);
  }

  return {
    inputArgs,
    filterParts,
    videoOut: "[vout]",
    audioOut: plan.source.hasAudio ? "[aout]" : null,
  };
}

export function buildSegmentRenderArgs(
  plan: SegmentPlan,
  options: SegmentRenderArgsOptions,
): string[] {
  const graph = buildSegmentFilterGraph(plan, options);
  return [
    "-y",
    ...graph.inputArgs,
    "-filter_complex",
    graph.filterParts.join(";"),
    "-map",
    graph.videoOut,
    ...(graph.audioOut ? ["-map", graph.audioOut, ...AUDIO_OPTS] : ["-an"]),
    ...H264_MEDIUM,
    "-r",
    filterNumber(plan.source.fps),
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    options.outputPath,
  ];
}
