const TIMEWARP_STRETCH_MIN = 0.25;
const TIMEWARP_STRETCH_MAX = 4;

export type TimewarpSegment = {
  kind: "prefix" | "selection" | "suffix";
  startSeconds: number;
  endSeconds: number;
  stretchFactor: number;
  outputDuration: number;
};

export type TimewarpPlan = {
  sourceDuration: number;
  sourceFps: number;
  startSeconds: number;
  endSeconds: number;
  stretchFactor: number;
  selectedSourceDuration: number;
  selectedOutputDuration: number;
  outsideSourceDuration: number;
  outsideOutputDuration: number;
  outsideStretchFactor: number;
  segments: TimewarpSegment[];
};

export type TimewarpPlanInput = {
  sourceDuration: number;
  sourceFps: number;
  startSeconds: number;
  endSeconds: number;
  stretchFactor: number;
};

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
}

function segment(
  kind: TimewarpSegment["kind"],
  startSeconds: number,
  endSeconds: number,
  stretchFactor: number,
): TimewarpSegment {
  return {
    kind,
    startSeconds,
    endSeconds,
    stretchFactor,
    outputDuration: (endSeconds - startSeconds) * stretchFactor,
  };
}

export function createTimewarpPlan(input: TimewarpPlanInput): TimewarpPlan {
  const {
    sourceDuration,
    sourceFps,
    startSeconds,
    endSeconds,
    stretchFactor,
  } = input;

  requireFinite("sourceDuration", sourceDuration);
  requireFinite("sourceFps", sourceFps);
  requireFinite("startSeconds", startSeconds);
  requireFinite("endSeconds", endSeconds);
  requireFinite("stretchFactor", stretchFactor);

  if (sourceDuration <= 0) throw new Error("Source duration must be greater than zero");
  if (sourceFps <= 0) throw new Error("Source frame rate must be greater than zero");
  if (startSeconds < 0 || startSeconds >= endSeconds || endSeconds > sourceDuration) {
    throw new Error(
      `Timewarp range must satisfy 0 <= start < end <= ${sourceDuration.toFixed(3)}`,
    );
  }
  if (stretchFactor < TIMEWARP_STRETCH_MIN || stretchFactor > TIMEWARP_STRETCH_MAX) {
    throw new Error(
      `Stretch factor must be between ${TIMEWARP_STRETCH_MIN} and ${TIMEWARP_STRETCH_MAX}`,
    );
  }
  if (stretchFactor === 1) throw new Error("Stretch factor 1 is a no-op");

  const selectedSourceDuration = endSeconds - startSeconds;
  const outsideSourceDuration = sourceDuration - selectedSourceDuration;
  if (outsideSourceDuration <= 0) {
    throw new Error("Timewarp range cannot cover the full clip");
  }

  const selectedOutputDuration = selectedSourceDuration * stretchFactor;
  const outsideOutputDuration = sourceDuration - selectedOutputDuration;
  if (outsideOutputDuration <= 0) {
    throw new Error("Stretch factor leaves no time for material outside the selection");
  }

  const outsideStretchFactor = outsideOutputDuration / outsideSourceDuration;
  const segments: TimewarpSegment[] = [];
  if (startSeconds > 0) {
    segments.push(segment("prefix", 0, startSeconds, outsideStretchFactor));
  }
  segments.push(segment("selection", startSeconds, endSeconds, stretchFactor));
  if (endSeconds < sourceDuration) {
    segments.push(segment("suffix", endSeconds, sourceDuration, outsideStretchFactor));
  }

  const frameDuration = 1 / sourceFps;
  const tooShort = segments.find((item) => item.outputDuration + 1e-9 < frameDuration);
  if (tooShort) {
    throw new Error(
      `${tooShort.kind} output is shorter than one source frame (${frameDuration.toFixed(6)}s)`,
    );
  }

  return {
    sourceDuration,
    sourceFps,
    startSeconds,
    endSeconds,
    stretchFactor,
    selectedSourceDuration,
    selectedOutputDuration,
    outsideSourceDuration,
    outsideOutputDuration,
    outsideStretchFactor,
    segments,
  };
}

function filterNumber(value: number): string {
  return Number(value.toFixed(12)).toString();
}

export function buildTimewarpVideoFilter(plan: TimewarpPlan): string {
  const filters = plan.segments.map((item, index) => {
    const start = filterNumber(item.startSeconds);
    const end = filterNumber(item.endSeconds);
    const factor = filterNumber(item.stretchFactor);
    return `[0:v:0]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)*${factor}[v${index}]`;
  });
  const inputs = plan.segments.map((_, index) => `[v${index}]`).join("");
  filters.push(`${inputs}concat=n=${plan.segments.length}:v=1:a=0[vout]`);
  return filters.join(";");
}
