import { kie, submitMediaJob } from "@apicity/kie";
import { fal, withFallback } from "@apicity/fal";

export type TranscribeSubmitArgs = {
  audioUrl: string;
  tagAudioEvents: boolean;
  diarize: boolean;
  languageCode?: string;
};

export type TranscribeSubmitResult = {
  provider: "fal" | "kie";
  taskId: string;
  taskType: "fal_transcribe" | "transcribe";
  endpointId?: string;
};

export const FAL_TRANSCRIBE_ENDPOINT_ID = "fal-ai/elevenlabs/speech-to-text/scribe-v2";

async function submitFal(args: TranscribeSubmitArgs): Promise<TranscribeSubmitResult> {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) throw new Error("FAL_API_KEY not set");

  const provider = fal({ apiKey, timeout: 60_000 });
  const submitResult = await provider.post.v1.queue.submit({
    endpoint_id: FAL_TRANSCRIBE_ENDPOINT_ID,
    input: {
      audio_url: args.audioUrl,
      tag_audio_events: args.tagAudioEvents,
      diarize: args.diarize,
      ...(args.languageCode ? { language_code: args.languageCode } : {}),
    },
  });

  return {
    provider: "fal",
    taskId: submitResult.request_id,
    taskType: "fal_transcribe",
    endpointId: FAL_TRANSCRIBE_ENDPOINT_ID,
  };
}

async function submitKie(args: TranscribeSubmitArgs): Promise<TranscribeSubmitResult> {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error("KIE_API_KEY not set");

  const provider = kie({ apiKey, timeout: 60_000 });
  const taskId = await submitMediaJob(provider, {
    model: "elevenlabs/speech-to-text",
    input: {
      audio_url: args.audioUrl,
      tag_audio_events: args.tagAudioEvents,
      diarize: args.diarize,
      ...(args.languageCode ? { language_code: args.languageCode } : {}),
    },
  });

  return { provider: "kie", taskId, taskType: "transcribe" };
}

export const submitTranscribe = withFallback<TranscribeSubmitArgs, TranscribeSubmitResult>(
  [submitFal, submitKie],
  {
    onFallback: (e: unknown, i: number) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[transcribe] provider ${i} failed, falling back: ${msg}`);
    },
  },
);
