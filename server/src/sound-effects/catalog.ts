export const BUILTIN_SOUND_IDS = [
  "zoom_in", "zoom_out", "whoosh", "swish", "pop", "click", "ding", "impact", "riser", "glitch", "shutdown", "error",
] as const;

export type BuiltinSoundId = typeof BUILTIN_SOUND_IDS[number];

/* Sounds that ship as a recording under ./recordings instead of being
   synthesized; everything else is rendered by ./synth.ts. */
export const BUILTIN_SOUND_RECORDINGS = {
  shutdown: "windows_shutdown.mp3",
} as const satisfies Partial<Record<BuiltinSoundId, string>>;

export type RecordedSoundId = keyof typeof BUILTIN_SOUND_RECORDINGS;
export type SynthSoundId = Exclude<BuiltinSoundId, RecordedSoundId>;

export function isRecordedSound(id: BuiltinSoundId): id is RecordedSoundId {
  return Object.hasOwn(BUILTIN_SOUND_RECORDINGS, id);
}

export const SYNTH_SOUND_IDS: readonly SynthSoundId[] = BUILTIN_SOUND_IDS.filter((id): id is SynthSoundId => !isRecordedSound(id));

interface BuiltinSound {
  id: BuiltinSoundId;
  title: string;
  description: string;
  durationSeconds: number;
  accentSeconds: number;
}

export const BUILTIN_SOUNDS: readonly BuiltinSound[] = [
  { id: "zoom_in", title: "Zoom in", description: "A rising rush swells into a close-up.", durationSeconds: 0.5, accentSeconds: 0.41 },
  { id: "zoom_out", title: "Zoom out", description: "A bright rush falls away into the distance.", durationSeconds: 0.5, accentSeconds: 0.09 },
  { id: "whoosh", title: "Whoosh", description: "A soft rush sweeps past from left to right.", durationSeconds: 0.45, accentSeconds: 0.225 },
  { id: "swish", title: "Swish", description: "A light high swipe punctuates a quick cut.", durationSeconds: 0.22, accentSeconds: 0.09 },
  { id: "pop", title: "Pop", description: "A rounded bubble pops with a quick pitch drop.", durationSeconds: 0.14, accentSeconds: 0.005 },
  { id: "click", title: "Click", description: "A crisp short tick marks a small action.", durationSeconds: 0.05, accentSeconds: 0.003 },
  { id: "ding", title: "Ding", description: "A clear bell rings out and gently fades.", durationSeconds: 1, accentSeconds: 0.005 },
  { id: "impact", title: "Impact", description: "A deep thump lands with a brief noisy edge.", durationSeconds: 0.6, accentSeconds: 0.01 },
  { id: "riser", title: "Riser", description: "A climbing tone and rush build anticipation.", durationSeconds: 1.5, accentSeconds: 1.425 },
  { id: "glitch", title: "Glitch", description: "Short digital bursts stutter between silent gaps.", durationSeconds: 0.3, accentSeconds: 0.01 },
  { id: "shutdown", title: "Shutdown", description: "The Windows shutdown chime, a recording.", durationSeconds: 3.24, accentSeconds: 0.02 },
  { id: "error", title: "Error", description: "Two short low tones mark an error.", durationSeconds: 0.35, accentSeconds: 0.02 },
];

export function builtinSound(id: BuiltinSoundId): BuiltinSound {
  return BUILTIN_SOUNDS.find((sound) => sound.id === id)!;
}

export function builtinSoundId(text: string): BuiltinSoundId | null {
  const normalized = text.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  return BUILTIN_SOUND_IDS.find((id) => id === normalized) ?? null;
}
