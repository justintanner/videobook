import type { BuiltinAudio } from "./synth.js";

export function encodeWav(audio: BuiltinAudio): Uint8Array {
  if (audio.left.length !== audio.right.length) throw new Error("Stereo channels must have equal lengths");
  const dataBytes = audio.left.length * 4;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < audio.left.length; index += 1) {
    for (const [channel, samples] of [audio.left, audio.right].entries()) {
      const sample = Math.max(-1, Math.min(1, samples[index]!));
      view.setInt16(44 + index * 4 + channel * 2, Math.round(sample * (sample < 0 ? 32_768 : 32_767)), true);
    }
  }
  return bytes;
}
