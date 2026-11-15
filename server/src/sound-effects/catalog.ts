export const BUILTIN_SOUND_IDS = [
  "zoom_in", "zoom_out", "whoosh", "swish", "pop", "click", "ding", "impact", "riser", "glitch",
] as const;

export type BuiltinSoundId = typeof BUILTIN_SOUND_IDS[number];

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
];

export function builtinSound(id: BuiltinSoundId): BuiltinSound {
  return BUILTIN_SOUNDS.find((sound) => sound.id === id)!;
}

export function builtinSoundId(text: string): BuiltinSoundId | null {
  const normalized = text.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  return BUILTIN_SOUND_IDS.find((id) => id === normalized) ?? null;
}
