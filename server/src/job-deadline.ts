const JOB_CANCELLATION_GRACE_MS = 10_000;

const JOB_TIMEOUTS_MS = new Map<string, number>([
  ["repair_search_indexes", 15 * 60_000],
  ["render_project", 30 * 60_000],
  ["render_timeline", 30 * 60_000],
  ["render_qr_outro", 15 * 60_000],
  ["analyze_keyword_placement", 5 * 60_000],
  ["analyze_alive_captions", 10 * 60_000],
  ["caption_transcript", 10 * 60_000],
  ["caption_vocal", 5 * 60_000],
  ["caption_regions", 10 * 60_000],
  ["osg_placement", 5 * 60_000],
  ["analyze_image_subjects", 30 * 60_000],
  ["generate_image_subject_edit", 30 * 60_000],
  ["burn_watermark", 15 * 60_000],
  // Whole-job backstop above the 30 min /synth fetch timeout, so the client's
  // more specific error wins when ace-server hangs; covers synth-lock wait,
  // first-request model load, and the ffmpeg passes on a 240 s CPU-only run.
  ["generate_acestep_cover", 45 * 60_000],
]);

export class JobDeadlineError extends Error {
  readonly jobType: string;
  readonly timeoutMs: number;

  constructor(jobType: string, timeoutMs: number) {
    super(`Job ${jobType} timed out after ${timeoutMs}ms`);
    this.name = "JobDeadlineError";
    this.jobType = jobType;
    this.timeoutMs = timeoutMs;
  }
}

type Settled<T> =
  | { state: "resolved"; value: T }
  | { state: "rejected"; error: unknown };

function getJobTimeoutMs(jobType: string): number | null {
  return JOB_TIMEOUTS_MS.get(jobType) ?? null;
}

export async function runWithJobDeadline<T>(
  jobType: string,
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | null = getJobTimeoutMs(jobType),
  cancellationGraceMs = JOB_CANCELLATION_GRACE_MS,
): Promise<T> {
  const controller = new AbortController();
  const work = Promise.resolve().then(() => run(controller.signal));
  if (timeoutMs === null) return work;

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const settled: Promise<Settled<T>> = work.then(
    (value): Settled<T> => ({ state: "resolved", value }),
    (error: unknown): Settled<T> => ({ state: "rejected", error }),
  );
  const deadline = new Promise<{ state: "deadline" }>((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ state: "deadline" }), timeoutMs);
    deadlineTimer.unref?.();
  });

  const first = await Promise.race([settled, deadline]);
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  if (first.state === "resolved") return first.value;
  if (first.state === "rejected") throw first.error;

  const timeoutError = new JobDeadlineError(jobType, timeoutMs);
  controller.abort(timeoutError);

  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, cancellationGraceMs);
    graceTimer.unref?.();
  });
  await Promise.race([settled.then(() => undefined), grace]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  throw timeoutError;
}
