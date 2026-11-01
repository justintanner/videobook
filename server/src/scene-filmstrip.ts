import { runFfmpeg } from "./ffmpeg.js";

export const SCENE_FILMSTRIP_FILE = ".detect-scenes-filmstrip.jpg";

const FRAME_HEIGHT = 72;
const MIN_FRAMES = 12;
const MAX_FRAMES = 60;

export type SceneFilmstrip = {
  file: string;
  frames: number;
  frameWidth: number;
  frameHeight: number;
  interval: number;
};

export function filmstripLayout(duration: number, width: number, height: number): Omit<SceneFilmstrip, "file"> {
  const frames = Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round(duration)));
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  const frameWidth = Math.max(2, Math.round((FRAME_HEIGHT * aspect) / 2) * 2);
  return { frames, frameWidth, frameHeight: FRAME_HEIGHT, interval: duration / frames };
}

export async function renderSceneFilmstrip(
  videoPath: string,
  outputPath: string,
  layout: Omit<SceneFilmstrip, "file">,
  signal?: AbortSignal,
): Promise<void> {
  const filter = [
    `fps=1/${layout.interval}`,
    `scale=${layout.frameWidth}:${layout.frameHeight}:force_original_aspect_ratio=decrease`,
    `pad=${layout.frameWidth}:${layout.frameHeight}:(ow-iw)/2:(oh-ih)/2`,
    `tile=${layout.frames}x1`,
  ].join(",");
  await runFfmpeg([
    "-y",
    "-i", videoPath,
    "-vf", filter,
    "-frames:v", "1",
    "-q:v", "5",
    "-an",
    outputPath,
  ], { signal });
}
