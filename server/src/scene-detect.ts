import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const sceneDetectRequire = createRequire(import.meta.url);
const FFMPEG: string = sceneDetectRequire("ffmpeg-static");

// Camera-cut threshold on scdet's absolute mean frame diff. ffmpeg's default
// scdet threshold is 10; we match that for the "shot" classification. Anything
// below this within a single shot is candidate territory for "settle".
const SHOT_SCORE_THRESHOLD = 10;
// scdet runs at this temporal resolution. 4 fps gives 0.25s candidate
// granularity — enough to land action endings cleanly while keeping the
// detection pass fast on long clips.
const SCDET_FPS = 4;
// Settle: within a single shot, look for the falling edge of motion. The
// frame must drop below the segment's 25th percentile after sustained motion
// above the 75th percentile, AND stay below p25 for at least this many
// seconds. Tuned so a short pause inside an action doesn't produce a false
// settle, but a real "the man finished standing up" landing does.
const SETTLE_HOLD_S = 0.5;

export type Candidate = { t: number; score: number; kind: "shot" | "settle" };

// Parse scdet's stderr stream. ffmpeg 6's scdet logs one line per processed
// frame in the form:
//   [scdet @ 0x...] lavfi.scd.score: 4.798, lavfi.scd.time: 0.25
// Score is the absolute mean frame difference (Y-plane), time is seconds.
// The very first line always has score=0 (no previous frame) — we keep it
// in the timeline; deriveCandidates ignores it via the threshold.
export function parseScdetOutput(stderr: string): Array<{ t: number; score: number }> {
  const re = /lavfi\.scd\.score:\s*([0-9.]+),\s*lavfi\.scd\.time:\s*([0-9.]+)/g;
  const out: Array<{ t: number; score: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const score = parseFloat(m[1]);
    const t = parseFloat(m[2]);
    if (Number.isFinite(score) && Number.isFinite(t)) out.push({ t, score });
  }
  return out;
}

// Two-tier candidate derivation from a per-frame scdet timeline:
//
// 1. shot   — any frame whose scdet score is ≥ SHOT_SCORE_THRESHOLD. These
//             are camera/cut changes. ffmpeg's default scdet threshold is the
//             same value; matching it keeps behavior aligned with the upstream
//             definition of "scene change".
//
// 2. settle — within each run of consecutive non-shot frames (a single shot),
//             find a falling edge: a frame where the score drops below the
//             segment's 25th percentile after sustained motion above the 75th
//             percentile, and stays below p25 for ≥ SETTLE_HOLD_S. The first
//             frame of the sustained-low region is the action's natural end.
//
// Settle scoring is (above-mean − below-mean), so deeper drops rank higher.
// Empty / quiet shots produce no settle candidates.
export function deriveCandidates(samples: Array<{ t: number; score: number }>): Candidate[] {
  if (samples.length === 0) return [];
  const out: Candidate[] = [];

  const shotIdx: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].score >= SHOT_SCORE_THRESHOLD) {
      shotIdx.push(i);
      out.push({ t: samples[i].t, score: samples[i].score, kind: "shot" });
    }
  }

  const segments: Array<[number, number]> = [];
  let segStart = 0;
  for (const i of shotIdx) {
    if (i > segStart) segments.push([segStart, i]);
    segStart = i + 1;
  }
  if (segStart < samples.length) segments.push([segStart, samples.length]);

  for (const [lo, hi] of segments) {
    const seg = samples.slice(lo, hi);
    if (seg.length < 3) continue;
    const sorted = [...seg.map((s) => s.score)].sort((a, b) => a - b);
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    const p75 = sorted[Math.floor(sorted.length * 0.75)];
    if (p75 <= p25) continue;

    let aboveSum = 0;
    let aboveCount = 0;
    for (let j = 0; j < seg.length; j++) {
      if (seg[j].score >= p75) {
        aboveSum += seg[j].score;
        aboveCount++;
      }
      if (aboveCount > 0 && seg[j].score <= p25) {
        const start = seg[j].t;
        let k = j;
        while (k < seg.length && seg[k].score <= p25 && seg[k].t - start < SETTLE_HOLD_S) k++;
        if (k < seg.length && seg[k].t - start >= SETTLE_HOLD_S) {
          let belowSum = 0;
          let belowCount = 0;
          for (let m = j; m < k; m++) {
            belowSum += seg[m].score;
            belowCount++;
          }
          const aboveMean = aboveSum / aboveCount;
          const belowMean = belowCount > 0 ? belowSum / belowCount : 0;
          out.push({ t: seg[j].t, score: Math.max(0, aboveMean - belowMean), kind: "settle" });
          j = k;
          aboveSum = 0;
          aboveCount = 0;
        }
      }
    }
  }

  out.sort((a, b) => a.t - b.t);
  return out;
}

// Run a single ffmpeg scdet pass over the input video at downscaled
// 320×180 / SCDET_FPS, parse the per-frame score timeline from stderr, and
// return shot + settle candidates. ffmpeg writes scdet's metadata to stderr
// (not stdout), so we capture stderr from the invocation. A non-zero exit is
// expected for `-f null -` runs only when ffmpeg actually fails — successful
// runs return cleanly with the metadata in stderr.
export async function detectSceneCandidates(videoPath: string): Promise<Candidate[]> {
  let stderr = "";
  try {
    const result = await execFileAsync(FFMPEG, [
      "-hide_banner",
      "-nostats",
      "-loglevel", "info",
      "-i", videoPath,
      "-vf", `scale=320:180,fps=${SCDET_FPS},scdet=threshold=0`,
      "-an",
      "-f", "null",
      "-",
    ], { maxBuffer: 64 * 1024 * 1024 });
    stderr = result.stderr;
  } catch (error) {
    const e = error as Error & { stderr?: string };
    if (typeof e.stderr === "string") {
      stderr = e.stderr;
    } else {
      throw new Error(`scdet pass failed: ${e.message}`);
    }
  }
  const samples = parseScdetOutput(stderr);
  return deriveCandidates(samples);
}
