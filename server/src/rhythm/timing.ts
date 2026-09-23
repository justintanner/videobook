import type { Sequence, SequenceClip, TimedSequenceClip } from "videobook-engine";
import type { MusicAnalysis, RhythmMarker, RhythmSettings } from "./model.js";

export function soundtrackClip(sequence: Sequence, settings: RhythmSettings): TimedSequenceClip | null {
  const audioTracks = new Set(sequence.tracks.filter((track) => track.kind === "audio").map((track) => track.trackId));
  const clips = sequence.clips.filter((clip): clip is TimedSequenceClip => audioTracks.has(clip.trackId) && clip.source.kind === "timed");
  return (settings.masterClipId ? clips.find((clip) => clip.clipId === settings.masterClipId) : clips.length === 1 ? clips[0] : null) ?? null;
}

export function effectiveMarkers(clip: TimedSequenceClip | null, settings: RhythmSettings, analysis: MusicAnalysis | null): RhythmMarker[] {
  if (!clip) return [];
  if (settings.correction) return settings.correction.objectHash === clip.source.range.objectHash ? settings.correction.markers : [];
  if (!analysis || analysis.objectHash !== clip.source.range.objectHash || analysis.streamId !== clip.source.range.streamId) return [];
  const bars = new Set(analysis.bars?.map((bar) => Math.round(bar.timeSeconds * 1000000)));
  return analysis.beats.map((beat, index) => ({
    id: `${analysis.analysisId.slice(0, 12)}-${index}`, timeSeconds: beat.timeSeconds,
    bar: bars.has(Math.round(beat.timeSeconds * 1000000)), manual: false,
  }));
}

export function groupBeatBars(markers: readonly RhythmMarker[], anchorId: string, beatsPerBar: number, bpm: number | null): RhythmMarker[] {
  const ordered = [...markers].sort((left, right) => left.timeSeconds - right.timeSeconds);
  const anchor = ordered.findIndex(marker => marker.id === anchorId);
  if (anchor < 0 || !Number.isInteger(beatsPerBar) || beatsPerBar < 1 || beatsPerBar > 16) throw new Error("Choose a first bar beat and 1–16 beats per bar");
  const period = bpm !== null && Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : null;
  const positions = [0];
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = ordered[index]!.timeSeconds - ordered[index - 1]!.timeSeconds;
    positions.push(positions[index - 1]! + (period === null ? 1 : Math.max(1, Math.round(gap / period))));
  }
  return ordered.map((marker, index) => ({
    ...marker, bar: (positions[index]! - positions[anchor]!) % beatsPerBar === 0, manual: true,
  }));
}

export function sourceTimeAtFrame(clip: TimedSequenceClip, frame: number, fps: number): number {
  const range = clip.source.range;
  const base = range.timeBase.numerator / range.timeBase.denominator;
  const elapsed = (frame - clip.timelineStartFrame) / fps * clip.speed.numerator / clip.speed.denominator;
  return clip.reverse ? (range.startTick + range.durationTicks) * base - elapsed : range.startTick * base + elapsed;
}

export function frameAtSourceTime(clip: TimedSequenceClip, seconds: number, fps: number): number {
  const range = clip.source.range;
  const base = range.timeBase.numerator / range.timeBase.denominator;
  const elapsed = clip.reverse ? (range.startTick + range.durationTicks) * base - seconds : seconds - range.startTick * base;
  return Math.round(clip.timelineStartFrame + elapsed * fps * clip.speed.denominator / clip.speed.numerator);
}

export function timelineMarkers(clip: TimedSequenceClip | null, markers: readonly RhythmMarker[], sequence: Pick<Sequence, "frameRate">): Array<RhythmMarker & { frame: number }> {
  if (!clip || !clip.enabled) return [];
  const fps = sequence.frameRate.numerator / sequence.frameRate.denominator;
  const range = clip.source.range;
  const base = range.timeBase.numerator / range.timeBase.denominator;
  const startSeconds = range.startTick * base;
  const endSeconds = (range.startTick + range.durationTicks) * base;
  const seen = new Set<number>();
  return markers.filter((marker) => marker.timeSeconds >= startSeconds && marker.timeSeconds < endSeconds)
    .map((marker) => ({ ...marker, frame: frameAtSourceTime(clip, marker.timeSeconds, fps) }))
    .filter((marker) => marker.frame >= clip.timelineStartFrame && marker.frame < clip.timelineStartFrame + clip.durationFrames)
    .sort((left, right) => left.frame - right.frame || Number(right.bar) - Number(left.bar))
    .filter((marker) => { if (seen.has(marker.frame)) return false; seen.add(marker.frame); return true; });
}

export function nearestBeat(frame: number, markers: readonly { frame: number; bar: boolean }[], mode: "off" | "beats" | "bars", threshold = Infinity): number {
  if (mode === "off") return Math.round(frame);
  let best = Math.round(frame);
  let distance = threshold;
  for (const marker of markers) {
    if (mode === "bars" && !marker.bar) continue;
    const delta = Math.abs(marker.frame - frame);
    if (delta < distance || delta === distance && marker.frame < best) {
      best = marker.frame;
      distance = delta;
    }
  }
  return best;
}

export function clipWaveform(clip: SequenceClip, waveform: readonly number[], sourceDuration: number, fps: number, samples = 256): number[] {
  if (clip.source.kind !== "timed" || !sourceDuration || !waveform.length) return [];
  const timed = clip as TimedSequenceClip;
  return Array.from({ length: samples }, (_, index) => {
    const start = sourceTimeAtFrame(timed, clip.timelineStartFrame + index / samples * clip.durationFrames, fps);
    const end = sourceTimeAtFrame(timed, clip.timelineStartFrame + (index + 1) / samples * clip.durationFrames, fps);
    const first = Math.max(0, Math.floor(Math.min(start, end) / sourceDuration * waveform.length));
    const last = Math.min(waveform.length, Math.max(first + 1, Math.ceil(Math.max(start, end) / sourceDuration * waveform.length)));
    let peak = 0;
    for (let bucket = first; bucket < last; bucket++) peak = Math.max(peak, waveform[bucket] ?? 0);
    return peak;
  });
}
