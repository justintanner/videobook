import { AUDIO_OPTS, H264_MEDIUM } from "../ffmpeg.js";
import {
  checkSegmentPlan,
  segmentOutputFrames,
  type PlanSegment,
  type SegmentPlan,
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

export function segmentPictureFilters(
  segment: PlanSegment,
  fps: number,
  options: { variableFrameRate: boolean },
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
