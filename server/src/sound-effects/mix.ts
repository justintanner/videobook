import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AUDIO_OPTS, probeVideo, runFfmpeg } from "../ffmpeg.js";
import type { BuiltinSoundId } from "./catalog.js";
import { renderBuiltinSound } from "./synth.js";
import { encodeWav } from "./wav.js";

export interface BuiltinSfxCue {
  sound: BuiltinSoundId;
  startSeconds: number;
  gain: number;
}

export async function writeBuiltinSfxFiles(scratchDir: string, cues: readonly BuiltinSfxCue[]): Promise<string[]> {
  const paths = new Map<BuiltinSoundId, string>();
  for (const { sound } of cues) {
    if (paths.has(sound)) continue;
    const path = join(scratchDir, `${sound}.wav`);
    await writeFile(path, encodeWav(renderBuiltinSound(sound)));
    paths.set(sound, path);
  }
  return cues.map(({ sound }) => paths.get(sound)!);
}

export function buildBuiltinSfxFilter(
  cues: readonly BuiltinSfxCue[],
  hasAudio: boolean,
  durationSeconds: number,
  options?: { baseInput?: string; firstCueInputIndex?: number },
): string {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("Video duration must be positive");
  if (cues.length === 0) throw new Error("At least one sound cue is required");
  const baseInput = options?.baseInput ?? "[0:a:0]";
  const firstCueInputIndex = options?.firstCueInputIndex ?? 1;
  const duration = durationSeconds.toFixed(6);
  const parts = [hasAudio
    ? `${baseInput}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[base]`
    : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS[base]`];
  cues.forEach((cue, index) => {
    if (!Number.isFinite(cue.startSeconds) || cue.startSeconds < 0) throw new Error("Cue start must be nonnegative");
    if (!Number.isFinite(cue.gain) || cue.gain < 0 || cue.gain > 1) throw new Error("Cue gain must be between 0 and 1");
    const delay = Math.round(cue.startSeconds * 48_000);
    parts.push(`[${firstCueInputIndex + index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${cue.gain},adelay=${delay}S|${delay}S[s${index}]`);
  });
  parts.push(`[base]${cues.map((_, index) => `[s${index}]`).join("")}amix=inputs=${cues.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=false[outa]`);
  return parts.join(";");
}

export async function mixBuiltinSfxIntoVideo(videoPath: string, outputPath: string, scratchDir: string, cues: readonly BuiltinSfxCue[], signal?: AbortSignal): Promise<void> {
  const source = await probeVideo(videoPath, { signal });
  if (!source.videoCodec) throw new Error("Source has no video stream");
  const duration = source.videoDuration > 0 ? source.videoDuration : source.duration;
  const filter = buildBuiltinSfxFilter(cues, source.hasAudio, duration);
  const paths = await writeBuiltinSfxFiles(scratchDir, cues);
  const args = ["-y", "-i", videoPath];
  for (const path of paths) args.push("-i", path);
  args.push("-filter_complex", filter, "-map", "0:v", "-c:v", "copy", "-map", "[outa]", ...AUDIO_OPTS, "-t", String(duration), outputPath);
  await runFfmpeg(args, { signal });
  const output = await probeVideo(outputPath, { signal });
  if (output.videoCodec !== source.videoCodec) throw new Error("Sound mix changed the video codec");
  if (!output.hasAudio) throw new Error("Sound mix output has no audio stream");
  if (Math.abs(output.duration - duration) > 0.5) throw new Error("Sound mix changed the video duration");
}
