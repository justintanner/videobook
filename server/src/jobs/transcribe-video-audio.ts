import type { ClipfirstFs } from "clipfirst-engine";
import { openai } from "@apicity/openai";
import { registerJobHandler } from "../queue.js";

type TranscribeVideoAudioPayload = {
  type: "transcribe_video_audio";
  videoPath: string;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

export function registerTranscribeVideoAudioJob(fs: ClipfirstFs): void {
  registerJobHandler("transcribe_video_audio", async (payload) => {
    const { assetId, projectSlug } = payload as TranscribeVideoAudioPayload;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { success: false, reason: "OPENAI_API_KEY not set" };

    // original.mp3 is extracted by process_video; consume it here.
    const readResult = await fs.readFile(assetId, "original.mp3", projectSlug);
    if (!readResult.ok) throw new Error(readResult.error.message);

    const file = new File([new Uint8Array(readResult.value)], "original.mp3", { type: "audio/mpeg" });
    const provider = openai({ apiKey, timeout: 120_000 });
    const result = await provider.post.v1.audio.transcriptions({
      file,
      model: "gpt-4o-mini-transcribe",
    });

    const jsonString = JSON.stringify(result, null, 2);
    await fs.writeFile(assetId, ".analysis.gpt4otrans.json", jsonString, projectSlug);

    return { success: true, text: result.text };
  });
}
