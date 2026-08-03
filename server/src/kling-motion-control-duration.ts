import type { Engine } from "videobook-engine";

export type KlingMotionControlOrientation = "image" | "video";

export const KLING_MOTION_CONTROL_MIN_DURATION_SECONDS = 3;
export const KLING_MOTION_CONTROL_IMAGE_MAX_DURATION_SECONDS = 10;
export const KLING_MOTION_CONTROL_VIDEO_MAX_DURATION_SECONDS = 30;

function durationLabel(duration: number): string {
  return `${Number(duration.toFixed(3))}s`;
}

function assetLabel(raw: string): string {
  return raw.startsWith("@") ? raw : `@${raw}`;
}

export async function assertKlingMotionControlDuration(
  engine: Engine,
  motionVideoSlug: string,
  orientation: KlingMotionControlOrientation = "video",
): Promise<number> {
  const assetId = motionVideoSlug.replace(/^@/, "");
  const metadata = await engine.metadata.artifacts.read<{ duration?: unknown }>(
    assetId,
    "original",
  );
  const duration = metadata.ok ? metadata.value.duration : undefined;
  const maximum = orientation === "image"
    ? KLING_MOTION_CONTROL_IMAGE_MAX_DURATION_SECONDS
    : KLING_MOTION_CONTROL_VIDEO_MAX_DURATION_SECONDS;
  if (
    typeof duration !== "number"
    || !Number.isFinite(duration)
    || duration <= 0
  ) {
    throw new Error(
      `Motion video ${assetLabel(motionVideoSlug)} has no measured duration. Process or re-import it before Kling 3.0 Motion Control so the ${KLING_MOTION_CONTROL_MIN_DURATION_SECONDS}–${maximum}s limit can be checked.`,
    );
  }
  if (duration < KLING_MOTION_CONTROL_MIN_DURATION_SECONDS) {
    throw new Error(
      `Motion video ${assetLabel(motionVideoSlug)} is ${durationLabel(duration)} — Kling 3.0 Motion Control requires at least ${KLING_MOTION_CONTROL_MIN_DURATION_SECONDS}s for character_orientation=${orientation}. Choose a longer source or use /split on a longer video to connect a ${KLING_MOTION_CONTROL_MIN_DURATION_SECONDS}–${maximum}s segment.`,
    );
  }
  if (duration > maximum) {
    const guidance = orientation === "image"
      ? `Set character_orientation=video for clips up to ${KLING_MOTION_CONTROL_VIDEO_MAX_DURATION_SECONDS}s, or use /split ${assetLabel(motionVideoSlug)} at ${maximum}s or earlier and connect a ${KLING_MOTION_CONTROL_MIN_DURATION_SECONDS}–${maximum}s segment.`
      : `Use /split ${assetLabel(motionVideoSlug)} at ${maximum}s or earlier and connect a ${KLING_MOTION_CONTROL_MIN_DURATION_SECONDS}–${maximum}s segment.`;
    throw new Error(
      `Motion video ${assetLabel(motionVideoSlug)} is ${durationLabel(duration)} — Kling 3.0 Motion Control accepts at most ${maximum}s for character_orientation=${orientation}. ${guidance}`,
    );
  }
  return duration;
}
