export const AUDIO_SYNC_STRETCH_MIN = 0.25;
export const AUDIO_SYNC_STRETCH_MAX = 4;

const EPSILON = 1e-9;

export type AudioSyncAnchor = {
  videoSeconds: number;
  audioSeconds: number;
};

export type AudioSyncSegment = {
  videoStartSeconds: number;
  videoEndSeconds: number;
  audioStartSeconds: number;
  audioEndSeconds: number;
  durationFactor: number;
  startDerivative: number;
  endDerivative: number;
  coefficients: readonly [number, number, number, number];
};

export type AudioSyncPlanInput = {
  videoDuration: number;
  audioDuration: number;
  sourceFps: number;
  anchors: readonly AudioSyncAnchor[];
};

export type AudioSyncPlan = {
  videoDuration: number;
  audioDuration: number;
  sourceFps: number;
  frameDuration: number;
  anchors: AudioSyncAnchor[];
  segments: AudioSyncSegment[];
};

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function endpointDerivative(
  firstInterval: number,
  secondInterval: number,
  firstSlope: number,
  secondSlope: number,
): number {
  const derivative = (
    (2 * firstInterval + secondInterval) * firstSlope
    - firstInterval * secondSlope
  ) / (firstInterval + secondInterval);
  if (derivative <= 0) return 0;
  if (secondSlope <= 0 && derivative > 3 * firstSlope) return 3 * firstSlope;
  return derivative;
}

function pchipDerivatives(intervals: readonly number[], slopes: readonly number[]): number[] {
  if (slopes.length === 1) return [slopes[0], slopes[0]];

  const derivatives = new Array<number>(slopes.length + 1);
  derivatives[0] = endpointDerivative(intervals[0], intervals[1], slopes[0], slopes[1]);
  derivatives[slopes.length] = endpointDerivative(
    intervals.at(-1)!,
    intervals.at(-2)!,
    slopes.at(-1)!,
    slopes.at(-2)!,
  );

  for (let index = 1; index < slopes.length; index++) {
    const previousSlope = slopes[index - 1];
    const nextSlope = slopes[index];
    if (previousSlope * nextSlope <= 0) {
      derivatives[index] = 0;
      continue;
    }
    const previousInterval = intervals[index - 1];
    const nextInterval = intervals[index];
    const firstWeight = 2 * nextInterval + previousInterval;
    const secondWeight = nextInterval + 2 * previousInterval;
    derivatives[index] = (firstWeight + secondWeight)
      / (firstWeight / previousSlope + secondWeight / nextSlope);
  }

  return derivatives;
}

function segmentDerivative(segment: AudioSyncSegment, normalizedTime: number): number {
  const [cubic, quadratic, linear] = segment.coefficients;
  const interval = segment.videoEndSeconds - segment.videoStartSeconds;
  return (
    3 * cubic * normalizedTime * normalizedTime
    + 2 * quadratic * normalizedTime
    + linear
  ) / interval;
}

function derivativeExtrema(segment: AudioSyncSegment): number[] {
  const [cubic, quadratic] = segment.coefficients;
  const values = [segmentDerivative(segment, 0), segmentDerivative(segment, 1)];
  if (Math.abs(cubic) <= EPSILON) return values;
  const criticalPoint = -quadratic / (3 * cubic);
  if (criticalPoint > 0 && criticalPoint < 1) {
    values.push(segmentDerivative(segment, criticalPoint));
  }
  return values;
}

function validateDerivativeBounds(segment: AudioSyncSegment, index: number): void {
  const extrema = derivativeExtrema(segment);
  const minimum = Math.min(...extrema);
  const maximum = Math.max(...extrema);
  if (minimum < AUDIO_SYNC_STRETCH_MIN - EPSILON
    || maximum > AUDIO_SYNC_STRETCH_MAX + EPSILON) {
    throw new Error(
      `Smooth retiming rate in segment ${index + 1} must stay between ${AUDIO_SYNC_STRETCH_MIN} and ${AUDIO_SYNC_STRETCH_MAX}`,
    );
  }
}

function normalizedAnchors(input: AudioSyncPlanInput): AudioSyncAnchor[] {
  const anchors: AudioSyncAnchor[] = [{ videoSeconds: 0, audioSeconds: 0 }];
  let suppliedStart = false;
  for (const anchor of input.anchors) {
    if (!suppliedStart && anchors.length === 1
      && anchor.videoSeconds === 0 && anchor.audioSeconds === 0) {
      suppliedStart = true;
      continue;
    }
    anchors.push({ ...anchor });
  }
  const finalAnchor = anchors.at(-1)!;
  if (finalAnchor.videoSeconds !== input.videoDuration
    || finalAnchor.audioSeconds !== input.audioDuration) {
    anchors.push({
      videoSeconds: input.videoDuration,
      audioSeconds: input.audioDuration,
    });
  }
  return anchors;
}

export function createAudioSyncPlan(input: AudioSyncPlanInput): AudioSyncPlan {
  requireFinite("videoDuration", input.videoDuration);
  requireFinite("audioDuration", input.audioDuration);
  requireFinite("sourceFps", input.sourceFps);
  if (input.videoDuration <= 0) throw new Error("Video duration must be greater than zero");
  if (input.audioDuration <= 0) throw new Error("Audio duration must be greater than zero");
  if (input.sourceFps <= 0) throw new Error("Source frame rate must be greater than zero");

  for (const [index, anchor] of input.anchors.entries()) {
    requireFinite(`anchors[${index}].videoSeconds`, anchor.videoSeconds);
    requireFinite(`anchors[${index}].audioSeconds`, anchor.audioSeconds);
    if (anchor.videoSeconds < 0 || anchor.videoSeconds > input.videoDuration) {
      throw new Error(`Video anchor ${index + 1} must be within the video duration`);
    }
    if (anchor.audioSeconds < 0 || anchor.audioSeconds > input.audioDuration) {
      throw new Error(`Audio anchor ${index + 1} must be within the audio duration`);
    }
  }

  const anchors = normalizedAnchors(input);
  const frameDuration = 1 / input.sourceFps;
  const intervals: number[] = [];
  const slopes: number[] = [];

  for (let index = 0; index < anchors.length - 1; index++) {
    const current = anchors[index];
    const next = anchors[index + 1];
    const videoInterval = next.videoSeconds - current.videoSeconds;
    const audioInterval = next.audioSeconds - current.audioSeconds;
    if (videoInterval <= EPSILON || audioInterval <= EPSILON) {
      throw new Error("Audio-sync anchors must be strictly increasing on both clocks");
    }
    if (videoInterval + EPSILON < frameDuration || audioInterval + EPSILON < frameDuration) {
      throw new Error(
        `Audio-sync anchor intervals must be at least one source frame (${frameDuration.toFixed(6)}s)`,
      );
    }
    const durationFactor = audioInterval / videoInterval;
    if (durationFactor < AUDIO_SYNC_STRETCH_MIN - EPSILON
      || durationFactor > AUDIO_SYNC_STRETCH_MAX + EPSILON) {
      throw new Error(
        `Segment duration factor must be between ${AUDIO_SYNC_STRETCH_MIN} and ${AUDIO_SYNC_STRETCH_MAX}`,
      );
    }
    intervals.push(videoInterval);
    slopes.push(durationFactor);
  }

  if (anchors.every((anchor) => nearlyEqual(anchor.videoSeconds, anchor.audioSeconds))) {
    throw new Error("Audio-sync map is a no-op");
  }

  const derivatives = pchipDerivatives(intervals, slopes);
  const segments = slopes.map((durationFactor, index): AudioSyncSegment => {
    const start = anchors[index];
    const end = anchors[index + 1];
    const interval = intervals[index];
    const startDerivative = derivatives[index];
    const endDerivative = derivatives[index + 1];
    const coefficients: readonly [number, number, number, number] = [
      2 * start.audioSeconds - 2 * end.audioSeconds
        + interval * (startDerivative + endDerivative),
      -3 * start.audioSeconds + 3 * end.audioSeconds
        - interval * (2 * startDerivative + endDerivative),
      interval * startDerivative,
      start.audioSeconds,
    ];
    const segment = {
      videoStartSeconds: start.videoSeconds,
      videoEndSeconds: end.videoSeconds,
      audioStartSeconds: start.audioSeconds,
      audioEndSeconds: end.audioSeconds,
      durationFactor,
      startDerivative,
      endDerivative,
      coefficients,
    };
    validateDerivativeBounds(segment, index);
    return segment;
  });

  return {
    videoDuration: input.videoDuration,
    audioDuration: input.audioDuration,
    sourceFps: input.sourceFps,
    frameDuration,
    anchors,
    segments,
  };
}

function findSegment(plan: AudioSyncPlan, videoSeconds: number): AudioSyncSegment {
  return plan.segments.find((segment) => videoSeconds <= segment.videoEndSeconds + EPSILON)
    ?? plan.segments.at(-1)!;
}

export function evaluateAudioSyncMap(plan: AudioSyncPlan, videoSeconds: number): number {
  requireFinite("videoSeconds", videoSeconds);
  if (videoSeconds < -EPSILON || videoSeconds > plan.videoDuration + EPSILON) {
    throw new Error("Video timestamp must be within the planned video duration");
  }
  const clamped = Math.min(plan.videoDuration, Math.max(0, videoSeconds));
  const segment = findSegment(plan, clamped);
  const interval = segment.videoEndSeconds - segment.videoStartSeconds;
  const normalizedTime = (clamped - segment.videoStartSeconds) / interval;
  const [cubic, quadratic, linear, constant] = segment.coefficients;
  return ((cubic * normalizedTime + quadratic) * normalizedTime + linear)
    * normalizedTime + constant;
}

export function evaluateAudioSyncDerivative(plan: AudioSyncPlan, videoSeconds: number): number {
  requireFinite("videoSeconds", videoSeconds);
  if (videoSeconds < -EPSILON || videoSeconds > plan.videoDuration + EPSILON) {
    throw new Error("Video timestamp must be within the planned video duration");
  }
  const clamped = Math.min(plan.videoDuration, Math.max(0, videoSeconds));
  const segment = findSegment(plan, clamped);
  const interval = segment.videoEndSeconds - segment.videoStartSeconds;
  return segmentDerivative(segment, (clamped - segment.videoStartSeconds) / interval);
}

function filterNumber(value: number): string {
  return Number(value.toFixed(12)).toString();
}

function setptsPolynomial(segment: AudioSyncSegment): string {
  const sourceTime = "((PTS-STARTPTS)*TB)";
  const start = filterNumber(segment.videoStartSeconds);
  const interval = filterNumber(segment.videoEndSeconds - segment.videoStartSeconds);
  const normalizedTime = `((${sourceTime}-${start})/${interval})`;
  const [cubic, quadratic, linear, constant] = segment.coefficients.map(filterNumber);
  return `(((${cubic}*${normalizedTime}+${quadratic})*${normalizedTime}+${linear})*${normalizedTime}+${constant})/TB`;
}

export function buildAudioSyncSetptsExpression(plan: AudioSyncPlan): string {
  let expression = setptsPolynomial(plan.segments.at(-1)!);
  for (let index = plan.segments.length - 2; index >= 0; index--) {
    const boundary = filterNumber(plan.segments[index].videoEndSeconds);
    expression = `if(lte((PTS-STARTPTS)*TB,${boundary}),${setptsPolynomial(plan.segments[index])},${expression})`;
  }
  return expression;
}

export function buildAudioSyncVideoFilter(plan: AudioSyncPlan): string {
  const fps = filterNumber(plan.sourceFps);
  const duration = filterNumber(plan.audioDuration);
  return `[0:v:0]setpts='${buildAudioSyncSetptsExpression(plan)}',fps=fps=${fps},tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration}[vout]`;
}
