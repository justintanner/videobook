import { PLAIN_TRANSCRIPT_FILE, TIMED_TRANSCRIPT_FILE } from "./transcript-projection.js";
import { VIDEO_ANALYSIS_FILE } from "./video-analysis-projection.js";

export const PICTURE_SIDECARS: readonly string[] = [VIDEO_ANALYSIS_FILE];

export const SOUND_SIDECARS: readonly string[] = [VIDEO_ANALYSIS_FILE, PLAIN_TRANSCRIPT_FILE, TIMED_TRANSCRIPT_FILE];
