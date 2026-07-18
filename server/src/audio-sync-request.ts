export type RequestedAudioSyncAnchor =
  | { videoSeconds: number; audioSeconds: number }
  | { videoSeconds: number; audioCue: string };
