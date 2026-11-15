import { builtinSound, type BuiltinSoundId } from "./sound-effects/catalog.js";

const DEFAULT_SCALE = 1.3;
const MIN_SCALE = 1.05;
const MAX_SCALE = 3;
const DEFAULT_FOCUS = 0.5;
const DEFAULT_RAMP_SECONDS = 0.3;
const MAX_RAMP_SECONDS = 5;
const MAX_ZOOMS = 8;
const MIN_ZOOM_FRAMES = 2;
const FRAME_EPSILON = 1e-6;
const FRAME_INDEX = "(in-1)";
const LATE_CUE_SECONDS = 0.05;

export type ZoomInput = {
  start_seconds: number;
  end_seconds?: number;
  scale?: number;
  focus_x?: number;
  focus_y?: number;
  ramp_in_seconds?: number;
  ramp_out_seconds?: number;
  sound?: BuiltinSoundId;
  return_sound?: BuiltinSoundId;
};

export type ZoomSoundCue = {
  sound: BuiltinSoundId;
  startSeconds: number;
};

export type ResolvedZoom = {
  index: number;
  startSeconds: number;
  endSeconds: number | null;
  scale: number;
  focusX: number;
  focusY: number;
  rampInSeconds: number;
  rampOutSeconds: number;
};

export type ZoomPlan = {
  sourceDuration: number;
  sourceFps: number;
  frameCount: number;
  zooms: ResolvedZoom[];
};

export type ZoomWindow = {
  scale: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type ZoomPlanInput = {
  sourceDuration: number;
  sourceFps: number;
  zooms: ZoomInput[];
};

type ZoomLimit = {
  field: "scale" | "focus_x" | "focus_y" | "ramp_in_seconds" | "ramp_out_seconds";
  fallback: number;
  min: number;
  max: number;
  range: string;
};

const SCALE_LIMIT: ZoomLimit = { field: "scale", fallback: DEFAULT_SCALE, min: MIN_SCALE, max: MAX_SCALE, range: `from ${MIN_SCALE} to ${MAX_SCALE}` };
const FOCUS_X_LIMIT: ZoomLimit = { field: "focus_x", fallback: DEFAULT_FOCUS, min: 0, max: 1, range: "from 0 (left edge) to 1 (right edge)" };
const FOCUS_Y_LIMIT: ZoomLimit = { field: "focus_y", fallback: DEFAULT_FOCUS, min: 0, max: 1, range: "from 0 (top edge) to 1 (bottom edge)" };
const RAMP_IN_LIMIT: ZoomLimit = { field: "ramp_in_seconds", fallback: DEFAULT_RAMP_SECONDS, min: 0, max: MAX_RAMP_SECONDS, range: `from 0 (a hard cut) to ${MAX_RAMP_SECONDS}` };
const RAMP_OUT_LIMIT: ZoomLimit = { ...RAMP_IN_LIMIT, field: "ramp_out_seconds" };

function zoomName(index: number): string {
  return `Zoom ${index + 1}`;
}

function formatSeconds(seconds: number): string {
  return `${Number(seconds.toFixed(3))} s`;
}

function frameAt(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

function requireNumber(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
}

function limitedValue(zoom: ZoomInput, index: number, limit: ZoomLimit): number {
  const value = zoom[limit.field] ?? limit.fallback;
  const name = `${zoomName(index)} ${limit.field}`;
  requireNumber(name, value);
  if (value < limit.min || value > limit.max) {
    throw new Error(`${name} must be ${limit.range}; got ${value}`);
  }
  return value;
}

function startFrameOf(zoom: ZoomInput, index: number, fps: number, frameCount: number): number {
  const name = zoomName(index);
  requireNumber(`${name} start_seconds`, zoom.start_seconds);
  if (zoom.start_seconds < 0) {
    throw new Error(`${name} start_seconds must be 0 or more; got ${zoom.start_seconds}`);
  }
  const startFrame = frameAt(zoom.start_seconds, fps);
  if (startFrame > frameCount - 1) {
    throw new Error(
      `${name} starts at ${formatSeconds(zoom.start_seconds)}, but the clip's last frame is at ${formatSeconds((frameCount - 1) / fps)}. Start at least one frame before the end.`,
    );
  }
  return startFrame;
}

function endFrameOf(zoom: ZoomInput, index: number, fps: number, frameCount: number): number | null {
  if (zoom.end_seconds === undefined) return null;
  const name = zoomName(index);
  requireNumber(`${name} end_seconds`, zoom.end_seconds);
  if (zoom.end_seconds <= zoom.start_seconds) {
    throw new Error(
      `${name} ends at ${formatSeconds(zoom.end_seconds)}, which is not after its start at ${formatSeconds(zoom.start_seconds)}. Give an end after the start, or leave it out to stay zoomed to the end of the clip.`,
    );
  }
  return Math.min(frameAt(zoom.end_seconds, fps), frameCount);
}

function resolveZoom(zoom: ZoomInput, index: number, fps: number, frameCount: number): ResolvedZoom {
  if (zoom.return_sound !== undefined && zoom.end_seconds === undefined) {
    throw new Error(`${zoomName(index)} has a return_sound but no end_seconds, so it never returns. Give it an end_seconds, or leave return_sound out.`);
  }
  const startFrame = startFrameOf(zoom, index, fps, frameCount);
  const endFrame = endFrameOf(zoom, index, fps, frameCount);
  const frames = (endFrame ?? frameCount) - startFrame;
  if (frames < MIN_ZOOM_FRAMES) {
    throw new Error(
      `${zoomName(index)} lasts ${frames} frame${frames === 1 ? "" : "s"} after snapping to the clip's ${Number(fps.toFixed(3))} fps; a zoom needs at least ${MIN_ZOOM_FRAMES} frames (${formatSeconds(MIN_ZOOM_FRAMES / fps)}).`,
    );
  }
  const scale = limitedValue(zoom, index, SCALE_LIMIT);
  const focusX = limitedValue(zoom, index, FOCUS_X_LIMIT);
  const focusY = limitedValue(zoom, index, FOCUS_Y_LIMIT);
  const rampIn = limitedValue(zoom, index, RAMP_IN_LIMIT);
  const requestedRampOut = limitedValue(zoom, index, RAMP_OUT_LIMIT);
  const rampOut = endFrame === null ? 0 : requestedRampOut;
  const shrink = Math.min(1, frames / fps / (rampIn + rampOut));
  return {
    index,
    startSeconds: startFrame / fps,
    endSeconds: endFrame === null ? null : endFrame / fps,
    scale,
    focusX,
    focusY,
    rampInSeconds: rampIn * shrink,
    rampOutSeconds: rampOut * shrink,
  };
}

function describeZoom(zoom: ResolvedZoom): string {
  const end = zoom.endSeconds === null ? "the end of the clip" : formatSeconds(zoom.endSeconds);
  return `${zoomName(zoom.index)} (${formatSeconds(zoom.startSeconds)} to ${end})`;
}

function rejectOverlaps(zooms: ResolvedZoom[], fps: number, frameCount: number): void {
  zooms.slice(1).forEach((zoom, position) => {
    const previous = zooms[position];
    const previousEnd = previous.endSeconds === null ? frameCount : frameAt(previous.endSeconds, fps);
    if (previousEnd > frameAt(zoom.startSeconds, fps)) {
      throw new Error(
        `${describeZoom(previous)} and ${describeZoom(zoom).toLowerCase()} overlap. End each zoom before the next one starts.`,
      );
    }
  });
}

export function createZoomPlan(input: ZoomPlanInput): ZoomPlan {
  const { sourceDuration, sourceFps, zooms } = input;
  requireNumber("The clip's duration", sourceDuration);
  requireNumber("The clip's frame rate", sourceFps);
  if (sourceDuration <= 0) throw new Error("The clip's duration must be greater than zero");
  if (sourceFps <= 0) throw new Error("The clip's frame rate must be greater than zero");
  const frameCount = frameAt(sourceDuration, sourceFps);
  if (frameCount < MIN_ZOOM_FRAMES) {
    throw new Error(`The clip is too short to zoom: a zoom needs at least ${MIN_ZOOM_FRAMES} frames`);
  }
  if (zooms.length === 0 || zooms.length > MAX_ZOOMS) {
    throw new Error(`Give from 1 to ${MAX_ZOOMS} zooms; got ${zooms.length}`);
  }
  const resolved = zooms
    .map((zoom, index) => resolveZoom(zoom, index, sourceFps, frameCount))
    .sort((a, b) => a.startSeconds - b.startSeconds || a.index - b.index);
  rejectOverlaps(resolved, sourceFps, frameCount);
  return { sourceDuration, sourceFps, frameCount, zooms: resolved };
}

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

function unitClip(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function zoomWeight(zoom: ResolvedZoom, frame: number, fps: number): number {
  const start = frameAt(zoom.startSeconds, fps);
  const wayIn = zoom.rampInSeconds === 0
    ? Number(frame >= start - FRAME_EPSILON)
    : smoothstep(unitClip((frame - start) / (zoom.rampInSeconds * fps)));
  if (zoom.endSeconds === null) return wayIn;
  const end = frameAt(zoom.endSeconds, fps);
  const wayOut = zoom.rampOutSeconds === 0
    ? Number(frame < end - FRAME_EPSILON)
    : smoothstep(unitClip((end - frame) / (zoom.rampOutSeconds * fps)));
  return Math.min(wayIn, wayOut);
}

export function zoomWindowAt(plan: ZoomPlan, seconds: number): ZoomWindow {
  const frame = seconds * plan.sourceFps;
  const active = plan.zooms
    .map((zoom) => ({ zoom, weight: zoomWeight(zoom, frame, plan.sourceFps) }))
    .find((item) => item.weight > 0);
  if (!active) return { scale: 1, x: 0, y: 0, width: 1, height: 1 };
  const scale = 1 + (active.zoom.scale - 1) * active.weight;
  const size = 1 / scale;
  return {
    scale,
    x: active.zoom.focusX * (1 - size),
    y: active.zoom.focusY * (1 - size),
    width: size,
    height: size,
  };
}

export function zoomScaleAt(plan: ZoomPlan, seconds: number): number {
  return zoomWindowAt(plan, seconds).scale;
}

function zoomCues(zoom: ResolvedZoom, input: ZoomInput): ZoomSoundCue[] {
  const wayIn = input.sound === undefined ? [] : [{
    sound: input.sound,
    startSeconds: Math.max(0, zoom.startSeconds + zoom.rampInSeconds - builtinSound(input.sound).accentSeconds),
  }];
  const wayBack = input.return_sound === undefined || zoom.endSeconds === null ? [] : [{
    sound: input.return_sound,
    startSeconds: zoom.endSeconds - zoom.rampOutSeconds,
  }];
  return [...wayIn, ...wayBack];
}

export function zoomSoundCues(plan: ZoomPlan, zooms: readonly ZoomInput[]): ZoomSoundCue[] {
  return plan.zooms
    .flatMap((zoom) => zoomCues(zoom, zooms[zoom.index]!))
    .filter((cue) => cue.startSeconds < plan.sourceDuration - LATE_CUE_SECONDS);
}

function filterNumber(value: number): string {
  return Number(value.toFixed(12)).toString();
}

function smoothstepExpression(u: string): string {
  return `${u}*${u}*(3-2*${u})`;
}

function weightExpression(zoom: ResolvedZoom, fps: number): string {
  const start = frameAt(zoom.startSeconds, fps);
  const wayIn = zoom.rampInSeconds === 0
    ? `gte(${FRAME_INDEX},${start})`
    : smoothstepExpression(`clip((${FRAME_INDEX}-${start})/${filterNumber(zoom.rampInSeconds * fps)},0,1)`);
  if (zoom.endSeconds === null) return wayIn;
  const end = frameAt(zoom.endSeconds, fps);
  const wayOut = zoom.rampOutSeconds === 0
    ? `lt(${FRAME_INDEX},${end})`
    : smoothstepExpression(`clip((${end}-${FRAME_INDEX})/${filterNumber(zoom.rampOutSeconds * fps)},0,1)`);
  return `min(${wayIn},${wayOut})`;
}

function scaleExpression(plan: ZoomPlan): string {
  const terms = plan.zooms.map((zoom) => `${filterNumber(zoom.scale - 1)}*${weightExpression(zoom, plan.sourceFps)}`);
  return ["1", ...terms].join("+");
}

function spanExpression(zoom: ResolvedZoom, fps: number): string {
  const start = `gte(${FRAME_INDEX},${frameAt(zoom.startSeconds, fps)})`;
  if (zoom.endSeconds === null) return start;
  return `${start}*lt(${FRAME_INDEX},${frameAt(zoom.endSeconds, fps)})`;
}

function focusExpression(plan: ZoomPlan, focus: (zoom: ResolvedZoom) => number): string {
  const values = new Set(plan.zooms.map(focus));
  if (values.size === 1) return filterNumber(focus(plan.zooms[0]));
  const terms = plan.zooms.map((zoom) => `${filterNumber(focus(zoom))}*${spanExpression(zoom, plan.sourceFps)}`);
  return `(${terms.join("+")})`;
}

export function buildZoomVideoFilter(plan: ZoomPlan, options: { variableFrameRate: boolean }): string {
  const scale = scaleExpression(plan);
  // perspective reads its corners as pixel indices, where 0 is the centre of the first pixel, while zoomWindowAt and the preview measure the window from the picture's edge; the -0.5 terms move the corners half a pixel times (1 - 1/Z) so the render matches the window.
  const left = `(${focusExpression(plan, (zoom) => zoom.focusX)}*W-0.5)*(1-1/ld(0))`;
  const top = `(${focusExpression(plan, (zoom) => zoom.focusY)}*H-0.5)*(1-1/ld(0))`;
  const right = `${left}+W/ld(0)`;
  const bottom = `${top}+H/ld(0)`;
  const corner = (expression: string): string => `'st(0,${scale});${expression}'`;
  const perspective = [
    `x0=${corner(left)}`,
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
  const chain = `perspective=${perspective}`;
  return options.variableFrameRate ? `fps=${filterNumber(plan.sourceFps)},${chain}` : chain;
}
