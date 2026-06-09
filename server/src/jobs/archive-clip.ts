import type { VideocityFs, AssetManifestFile } from "vc-engine";
import type {
  ElevenLabsSpeechToTextRequest,
  ElevenLabsSpeechToTextResponse,
  ElevenLabsTranscript,
  ElevenLabsTranscriptWord,
  ElevenLabsTranscriptCharacter,
} from "@apicity/elevenlabs";
import { findAudioFile, findPrimaryMediaFile, findVideoFile } from "vc-engine";
import { createElevenLabs } from "@apicity/elevenlabs";
import { createOpenAi, firstContent } from "@apicity/openai";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { YtDlp } from "ytdlp-nodejs";
import { registerJobHandler } from "../queue.js";
import { getApiKey, requireApiKey } from "../api-key.js";
import { probeVideo, runFfmpeg } from "../ffmpeg.js";
import { validateDownloadOutput } from "./download-video.js";
import { withLocalLease } from "./_lease.js";
import {
  archiveTags,
  chunkKey,
  clipKey,
  contentTypeForFilename,
  createArchiveB2,
  getArchiveConfig,
  getJson,
  hashFile,
  indexKey,
  ingestKey,
  mergeArchiveIngests,
  objectExists,
  personMarkerKey,
  putJson,
  putText,
  readArchiveIngests,
  topicMarkerKey,
  transcriptJsonKey,
  transcriptTextKey,
  uploadFileToB2,
} from "../archive-b2.js";
import type { ArchiveIndex, ArchiveIngest, ArchiveSourceRef } from "../archive-b2.js";

type ArchiveClipPayload = {
  type: "archive_clip";
  projectSlug: string;
  assetId?: string;
  sourceProjectSlug?: string;
  url?: string;
  title?: string;
  topics: string[];
  people: string[];
  languageCode?: string;
  tagAudioEvents: boolean;
  diarize: boolean;
  ingestId: string;
};

type PreparedMedia = {
  mediaPath: string;
  filename: string;
  source: ArchiveSourceRef;
  cleanup?: () => Promise<void>;
  analysisTopics: string[];
};

type TranscriptResult = {
  transcript: ArchiveIndex["transcript"];
  text: string;
  duration: number | null;
};

const MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv", ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
const CHUNK_SECONDS = 20 * 60;
const ELEVENLABS_TIMEOUT_MS = 10 * 60_000;
const ENRICHMENT_MODEL = "gpt-5.4";

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function sourceTitle(title: string | undefined, fallback: string | undefined): string | undefined {
  const value = title?.trim() || fallback?.trim();
  return value || undefined;
}

function pickMediaFile(files: AssetManifestFile[], assetId: string): AssetManifestFile | null {
  const full = files.find((file) => /^original_full\.(mp4|mov|webm|avi|mkv)$/i.test(file.name));
  return full
    ?? findPrimaryMediaFile(files, assetId)
    ?? findVideoFile(files)
    ?? findAudioFile(files, assetId);
}

async function readAnalysisTopics(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
): Promise<string[]> {
  const read = await fs.readFile(assetId, ".original.analysis.json", projectSlug);
  if (!read.ok) return [];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(read.value)) as Record<string, unknown>;
    const topics = [
      ...readStringArray(parsed.tags),
      ...readStringArray(parsed.actions),
    ];
    const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
    for (const scene of scenes) {
      if (scene && typeof scene === "object") {
        topics.push(...readStringArray((scene as Record<string, unknown>).tags));
      }
    }
    return topics;
  } catch {
    return [];
  }
}

async function prepareAssetMedia(
  fs: VideocityFs,
  payload: ArchiveClipPayload,
): Promise<PreparedMedia> {
  if (!payload.assetId || !payload.sourceProjectSlug) {
    throw new Error("asset archive requires assetId and sourceProjectSlug");
  }
  const manifest = await fs.getManifest(payload.assetId, payload.sourceProjectSlug, { includeDotfiles: true });
  if (!manifest.ok) throw new Error(manifest.error.message);
  const media = pickMediaFile(manifest.value.files, payload.assetId);
  if (!media) throw new Error(`No media file found in asset ${payload.assetId}`);
  const extension = extname(media.name).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(extension)) {
    throw new Error(`Archive only supports video/audio media, got ${media.name}`);
  }
  const title = sourceTitle(payload.title, media.name.replace(/\.[^.]+$/, ""));
  return {
    mediaPath: join(manifest.value.path, media.name),
    filename: `original${extension}`,
    source: {
      kind: "asset",
      project_slug: payload.sourceProjectSlug,
      asset_id: payload.assetId,
      ...(title ? { title } : {}),
      created_at: new Date().toISOString(),
    },
    analysisTopics: await readAnalysisTopics(fs, payload.assetId, payload.sourceProjectSlug),
  };
}

async function prepareUrlMedia(payload: ArchiveClipPayload): Promise<PreparedMedia> {
  if (!payload.url) throw new Error("url archive requires url");
  const dir = await mkdtemp(join(tmpdir(), "videocity-archive-"));
  const outputPath = join(dir, "original.mp4");
  const ytdlp = new YtDlp();
  try {
    await ytdlp
      .download(payload.url)
      .setOutputTemplate(outputPath)
      .addArgs("--merge-output-format", "mp4")
      .addArgs("--no-playlist")
      .run();
    await validateDownloadOutput(outputPath);
    return {
      mediaPath: outputPath,
      filename: "original.mp4",
      source: {
        kind: "url",
        url: payload.url,
        ...(payload.title?.trim() ? { title: payload.title.trim() } : {}),
        created_at: new Date().toISOString(),
      },
      cleanup: () => rm(dir, { recursive: true, force: true }),
      analysisTopics: [],
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function offsetCharacter(char: ElevenLabsTranscriptCharacter, seconds: number): ElevenLabsTranscriptCharacter {
  return { ...char, start: char.start + seconds, end: char.end + seconds };
}

function offsetWord(word: ElevenLabsTranscriptWord, seconds: number): ElevenLabsTranscriptWord {
  return {
    ...word,
    start: word.start + seconds,
    end: word.end + seconds,
    ...(word.characters ? { characters: word.characters.map((char: ElevenLabsTranscriptCharacter) => offsetCharacter(char, seconds)) } : {}),
  };
}

function transcriptFromResponse(response: ElevenLabsSpeechToTextResponse): ElevenLabsTranscript {
  if ("words" in response) return response;
  if ("transcripts" in response && response.transcripts[0]) return response.transcripts[0];
  throw new Error("ElevenLabs returned an async acknowledgement instead of a transcript");
}

function mergeTranscripts(chunks: Array<{ transcript: ElevenLabsTranscript; offset: number }>, duration: number | null): ElevenLabsTranscript {
  const words = chunks.flatMap((chunk) => chunk.transcript.words.map((word: ElevenLabsTranscriptWord) => offsetWord(word, chunk.offset)));
  const texts = chunks.map((chunk) => chunk.transcript.text.trim()).filter(Boolean);
  const first = chunks[0]?.transcript;
  return {
    language_code: first?.language_code ?? "und",
    language_probability: first?.language_probability ?? 0,
    text: texts.join(" ").trim(),
    words,
    channel_index: first?.channel_index ?? 0,
    transcription_id: null,
    audio_duration_secs: duration ?? chunks.reduce((sum, chunk) => sum + chunk.transcript.audio_duration_secs, 0),
  };
}

function chunkStarts(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0];
  const count = Math.max(1, Math.ceil(duration / CHUNK_SECONDS));
  return Array.from({ length: count }, (_, index) => index * CHUNK_SECONDS);
}

async function extractAudioChunk(mediaPath: string, start: number, duration: number, chunkPath: string): Promise<void> {
  await runFfmpeg([
    "-y",
    ...(start > 0 ? ["-ss", String(start)] : []),
    ...(duration > 0 ? ["-t", String(duration)] : []),
    "-i", mediaPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-acodec", "libmp3lame",
    "-q:a", "5",
    "-f", "mp3",
    chunkPath,
  ]);
}

async function transcribeMedia(
  args: {
    mediaPath: string;
    sha256: string;
    languageCode?: string;
    tagAudioEvents: boolean;
    diarize: boolean;
  },
): Promise<TranscriptResult> {
  const config = getArchiveConfig();
  const b2 = createArchiveB2(config);
  const probe = await probeVideo(args.mediaPath);
  if (!probe.hasAudio) {
    const empty: ElevenLabsTranscript = {
      language_code: args.languageCode ?? "und",
      language_probability: 0,
      text: "",
      words: [],
      channel_index: 0,
      transcription_id: null,
      audio_duration_secs: probe.duration,
    };
    await putJson(b2, config.bucket, transcriptJsonKey(config, args.sha256), empty);
    await putText(b2, config.bucket, transcriptTextKey(config, args.sha256), "");
    return {
      transcript: {
        json_key: transcriptJsonKey(config, args.sha256),
        text_key: transcriptTextKey(config, args.sha256),
        chunk_count: 0,
        provider: "elevenlabs",
      },
      text: "",
      duration: probe.duration,
    };
  }

  const apiKey = requireApiKey("ELEVENLABS_API_KEY");
  const provider = createElevenLabs({ apiKey, timeout: ELEVENLABS_TIMEOUT_MS });
  const dir = await mkdtemp(join(tmpdir(), "videocity-archive-audio-"));
  const chunks: Array<{ transcript: ElevenLabsTranscript; offset: number }> = [];
  try {
    const starts = chunkStarts(probe.duration);
    for (let index = 0; index < starts.length; index++) {
      const start = starts[index];
      const length = probe.duration > 0
        ? Math.max(0.1, Math.min(CHUNK_SECONDS, probe.duration - start))
        : 0;
      const chunkPath = join(dir, `chunk-${String(index).padStart(3, "0")}.mp3`);
      await extractAudioChunk(args.mediaPath, start, length, chunkPath);
      const bytes = await readFile(chunkPath);
      const file = new Blob([new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))], { type: "audio/mpeg" });
      const request: ElevenLabsSpeechToTextRequest = {
        model_id: "scribe_v2",
        file,
        tag_audio_events: args.tagAudioEvents,
        diarize: args.diarize,
        ...(args.languageCode ? { language_code: args.languageCode } : {}),
      };
      const response = await provider.v1.speechToText(request);
      await putJson(b2, config.bucket, chunkKey(config, args.sha256, index), response);
      chunks.push({ transcript: transcriptFromResponse(response), offset: start });
    }
    const merged = mergeTranscripts(chunks, probe.duration);
    await putJson(b2, config.bucket, transcriptJsonKey(config, args.sha256), merged);
    await putText(b2, config.bucket, transcriptTextKey(config, args.sha256), merged.text);
    return {
      transcript: {
        json_key: transcriptJsonKey(config, args.sha256),
        text_key: transcriptTextKey(config, args.sha256),
        chunk_count: chunks.length,
        provider: "elevenlabs",
      },
      text: merged.text,
      duration: probe.duration,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sampleTranscript(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 14000) return clean;
  const head = clean.slice(0, 6000);
  const middleStart = Math.max(0, Math.floor(clean.length / 2) - 3000);
  const middle = clean.slice(middleStart, middleStart + 6000);
  const tail = clean.slice(-4000);
  return [head, middle, tail].join("\n\n");
}

async function enrichMetadata(title: string | null, transcript: string): Promise<{ topics: string[]; people: string[] }> {
  const apiKey = getApiKey("OPENAI_API_KEY");
  const sample = sampleTranscript(transcript);
  if (!apiKey || (!title && !sample)) return { topics: [], people: [] };
  const provider = createOpenAi({ apiKey, timeout: 120_000 });
  try {
    const response = await provider.post.v1.chat.completions({
      model: ENRICHMENT_MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content: "Return JSON only with topics:string[] and people:string[]. Topics are searchable subjects. People are named people only, not generic roles.",
        },
        {
          role: "user",
          content: `Title: ${title ?? ""}\n\nTranscript sample:\n${sample}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_completion_tokens: 1000,
    });
    const parsed = JSON.parse(firstContent(response)) as Record<string, unknown>;
    return {
      topics: readStringArray(parsed.topics),
      people: readStringArray(parsed.people),
    };
  } catch {
    return { topics: [], people: [] };
  }
}

async function writeMarkers(args: {
  ingest: ArchiveIngest;
  config: ReturnType<typeof getArchiveConfig>;
  b2: ReturnType<typeof createArchiveB2>;
}): Promise<void> {
  const marker = {
    sha256: args.ingest.sha256,
    ingest_id: args.ingest.ingest_id,
    title: args.ingest.title,
    topics: args.ingest.topics,
    people: args.ingest.people,
    index_key: indexKey(args.config, args.ingest.sha256),
    created_at: args.ingest.created_at,
  };
  await Promise.all([
    ...args.ingest.topics.map((topic) =>
      putJson(
        args.b2,
        args.config.bucket,
        topicMarkerKey(args.config, topic.key, args.ingest.sha256, args.ingest.ingest_id),
        marker,
      ),
    ),
    ...args.ingest.people.map((person) =>
      putJson(
        args.b2,
        args.config.bucket,
        personMarkerKey(args.config, person.key, args.ingest.sha256, args.ingest.ingest_id),
        marker,
      ),
    ),
  ]);
}

async function buildAndWriteIndex(args: {
  sha256: string;
  mediaKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  transcript: ArchiveIndex["transcript"];
  duration: number | null;
  existing: ArchiveIndex | null;
  config: ReturnType<typeof getArchiveConfig>;
  b2: ReturnType<typeof createArchiveB2>;
}): Promise<ArchiveIndex> {
  const ingests = await readArchiveIngests(args.b2, args.config, args.sha256);
  const index = mergeArchiveIngests(ingests, {
    sha256: args.sha256,
    mediaKey: args.mediaKey,
    filename: args.filename,
    contentType: args.contentType,
    sizeBytes: args.sizeBytes,
    transcript: args.transcript,
    duration: args.duration,
    existing: args.existing,
  });
  await putJson(args.b2, args.config.bucket, indexKey(args.config, args.sha256), index);
  return index;
}

async function runArchive(fs: VideocityFs, payload: ArchiveClipPayload): Promise<Record<string, unknown>> {
  const prepared = payload.url ? await prepareUrlMedia(payload) : await prepareAssetMedia(fs, payload);
  try {
    const config = getArchiveConfig();
    const b2 = createArchiveB2(config);
    const sha256 = await hashFile(prepared.mediaPath);
    const existing = await getJson<ArchiveIndex>(b2, config.bucket, indexKey(config, sha256));
    const duplicate = existing !== null;
    const contentType = duplicate ? existing.media.content_type : contentTypeForFilename(prepared.filename);
    const mediaKey = duplicate ? existing.media.key : clipKey(config, sha256, prepared.filename);
    const size = duplicate ? existing.media.size_bytes : (await import("node:fs/promises")).stat(prepared.mediaPath).then((item) => item.size);
    const sizeBytes = await size;

    let transcript = existing?.transcript ?? null;
    let transcriptText = "";
    let duration = existing?.duration ?? null;

    if (!duplicate) {
      if (!(await objectExists(b2, config.bucket, mediaKey))) {
        await uploadFileToB2(b2, config.bucket, mediaKey, prepared.mediaPath, contentType);
      }
      const transcriptResult = await transcribeMedia({
        mediaPath: prepared.mediaPath,
        sha256,
        languageCode: payload.languageCode,
        tagAudioEvents: payload.tagAudioEvents,
        diarize: payload.diarize,
      });
      transcript = transcriptResult.transcript;
      transcriptText = transcriptResult.text;
      duration = transcriptResult.duration;
    }

    const title = sourceTitle(payload.title, prepared.source.title);
    const enriched = duplicate ? { topics: [], people: [] } : await enrichMetadata(title ?? null, transcriptText);
    const manualTopics = archiveTags(payload.topics, "manual");
    const manualPeople = archiveTags(payload.people, "manual");
    const autoTopics = archiveTags([...prepared.analysisTopics, ...enriched.topics], "auto");
    const autoPeople = archiveTags(enriched.people, "auto");
    const ingest: ArchiveIngest = {
      schema_version: 1,
      ingest_id: payload.ingestId,
      sha256,
      source: prepared.source,
      title: title ?? null,
      topics: [...manualTopics, ...autoTopics],
      people: [...manualPeople, ...autoPeople],
      created_at: new Date().toISOString(),
    };

    await putJson(b2, config.bucket, ingestKey(config, sha256, payload.ingestId), ingest);
    await writeMarkers({ ingest, config, b2 });
    const index = await buildAndWriteIndex({
      sha256,
      mediaKey,
      filename: duplicate ? existing.media.filename : prepared.filename,
      contentType,
      sizeBytes,
      transcript,
      duration,
      existing,
      config,
      b2,
    });

    return {
      archive_id: sha256,
      sha256,
      duplicate,
      ingest_id: payload.ingestId,
      topics: index.topics.map((topic) => topic.label),
      people: index.people.map((person) => person.label),
    };
  } finally {
    await prepared.cleanup?.();
  }
}

export function registerArchiveClipJob(fs: VideocityFs): void {
  registerJobHandler("archive_clip", async (payload, ctx) => {
    const p = payload as ArchiveClipPayload;
    if (p.assetId) {
      return withLocalLease(fs, p.sourceProjectSlug ?? p.projectSlug, p.assetId, ctx, "download", async () => runArchive(fs, p));
    }
    return runArchive(fs, { ...p, ingestId: p.ingestId || randomUUID() });
  });
}

export const __archiveClipJobTest = {
  archiveTags,
  chunkStarts,
  mergeTranscripts,
  sampleTranscript,
};
