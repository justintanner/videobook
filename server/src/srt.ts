export function srtTimestamp(seconds: number): string {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const secs = Math.floor((millis % 60_000) / 1000);
  const remainder = millis % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(remainder).padStart(3, "0")}`;
}

export type SrtCue = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export function srtContent(cues: readonly SrtCue[]): string {
  return cues.map((cue, index) => [
    String(index + 1),
    `${srtTimestamp(cue.startSeconds)} --> ${srtTimestamp(cue.endSeconds)}`,
    cue.text,
    "",
  ].join("\n")).join("\n");
}
