import { fileURLToPath } from "node:url";
import { BUILTIN_SOUND_RECORDINGS, type RecordedSoundId } from "./catalog.js";

export function builtinRecordingPath(id: RecordedSoundId): string {
  return fileURLToPath(new URL(`./recordings/${BUILTIN_SOUND_RECORDINGS[id]}`, import.meta.url));
}
