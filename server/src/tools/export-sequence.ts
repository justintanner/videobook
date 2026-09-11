import type { Engine, Sequence } from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

type ExportOrientation = "landscape" | "portrait" | "square";
type CaptionMode = "burn-in" | "sidecar" | "omit";

interface ExportIssue {
  code: string;
  message: string;
  clipId?: string;
  cueId?: string;
}

interface SequenceExportValidation {
  valid: boolean;
  sequenceId: string;
  revision: string;
  durationFrames: number;
  orientation: ExportOrientation;
  width: number;
  height: number;
  captions: CaptionMode;
  inputObjectHashes: string[];
  errors: ExportIssue[];
  warnings: ExportIssue[];
}

const exportSettingsSchema = z.object({
  sequence_revision: z.string().min(1),
  orientation: z.enum(["landscape", "portrait", "square"]),
  captions: z.enum(["burn-in", "sidecar", "omit"]),
});

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function sequenceExportDimensions(orientation: ExportOrientation): [number, number] {
  if (orientation === "portrait") return [1080, 1920];
  if (orientation === "square") return [1080, 1080];
  return [1920, 1080];
}

function sequenceDuration(sequence: Sequence): number {
  return Math.max(
    0,
    ...sequence.clips.map((clip) =>
      clip.timelineStartFrame + clip.durationFrames),
    ...sequence.captions.map((cue) =>
      cue.timelineStartFrame + cue.durationFrames),
  );
}

export async function validateSequenceExport(
  engine: Engine,
  settings: z.infer<typeof exportSettingsSchema>,
): Promise<SequenceExportValidation> {
  const sequence = engine.sequences.getPrimary();
  const errors: ExportIssue[] = [];
  const warnings: ExportIssue[] = [];
  const objectHashes = new Set<string>();
  const [width, height] = sequenceExportDimensions(settings.orientation);
  const durationFrames = sequenceDuration(sequence);
  if (
    settings.sequence_revision !== sequence.revision
    || settings.sequence_revision !== engine.head
  ) {
    errors.push({
      code: "STALE_REVISION",
      message: `Requested ${settings.sequence_revision} but the current revision is ${engine.head}`,
    });
  }
  if (durationFrames < 1) {
    errors.push({
      code: "EMPTY_SEQUENCE",
      message: "The sequence has no playable duration",
    });
  }
  const enabledTracks = new Map(sequence.tracks
    .filter((track) => track.enabled)
    .map((track) => [track.trackId, track]));
  for (const clip of sequence.clips.filter((candidate) => candidate.enabled)) {
    const track = enabledTracks.get(clip.trackId);
    if (!track || track.kind === "caption") {
      errors.push({
        code: "MISSING_TRACK",
        message: "The clip is not on an enabled media track",
        clipId: clip.clipId,
      });
      continue;
    }
    const transform = clip.transform;
    if (
      transform
      && (
        transform.anchorX !== 0.5
        || transform.anchorY !== 0.5
        || transform.cropLeft + transform.cropRight >= 1
        || transform.cropTop + transform.cropBottom >= 1
      )
    ) {
      errors.push({
        code: "UNSUPPORTED_EFFECT",
        message: "This export renderer requires a centered anchor and non-empty crop",
        clipId: clip.clipId,
      });
    }
    const artifact = engine.artifacts.get(clip.source.artifactId);
    if (!artifact.ok) {
      errors.push({
        code: "MISSING_MEDIA",
        message: artifact.error.message,
        clipId: clip.clipId,
      });
      continue;
    }
    const manifest = await engine.files.manifest(artifact.value.artifactId);
    if (!manifest.ok) {
      errors.push({
        code: "OFFLINE_OBJECT",
        message: manifest.error.message,
        clipId: clip.clipId,
      });
      continue;
    }
    let expectedHash: string;
    let sourcePath: string | undefined;
    if (clip.source.kind === "timed") {
      expectedHash = clip.source.range.objectHash;
      const streamId = clip.source.range.streamId;
      const streams = engine.streams.list(artifact.value.artifactId);
      sourcePath = streams.ok
        ? streams.value.find((stream) =>
            stream.streamId === streamId)?.sourcePath
        : undefined;
    } else {
      expectedHash = clip.source.objectHash;
      sourcePath = clip.source.sourcePath;
    }
    const file = manifest.value.files.find((candidate) =>
      candidate.objectHash === expectedHash
      && (sourcePath === undefined || candidate.name === sourcePath));
    if (!file) {
      errors.push({
        code: "SOURCE_REPLACED",
        message: "The immutable source snapshot is not available locally",
        clipId: clip.clipId,
      });
      continue;
    }
    objectHashes.add(file.objectHash);
  }
  if (settings.captions !== "omit") {
    for (const cue of sequence.captions) {
      const seconds = cue.durationFrames
        * sequence.frameRate.denominator
        / sequence.frameRate.numerator;
      if (cue.text.length > Math.max(42, Math.floor(seconds * 28))) {
        warnings.push({
          code: "CAPTION_OVERFLOW",
          message: "Caption text may not fit its display duration",
          cueId: cue.cueId,
        });
      }
    }
  }
  return {
    valid: errors.length === 0,
    sequenceId: sequence.sequenceId,
    revision: sequence.revision,
    durationFrames,
    orientation: settings.orientation,
    width,
    height,
    captions: settings.captions,
    inputObjectHashes: [...objectHashes].sort(),
    errors,
    warnings,
  };
}

export function exportSequenceDefs(engine: Engine): ToolDef[] {
  return [
    {
      name: "validate_sequence_export",
      description: "Validate a revision-pinned canonical sequence export and resolve immutable inputs",
      scope: "book",
      schema: {
        book_id: z.string().uuid(),
        ...exportSettingsSchema.shape,
      },
      handler: async (args) => json(await validateSequenceExport(
        engine,
        args as unknown as z.infer<typeof exportSettingsSchema>,
      )),
    },
    {
      name: "plan_sequence_export",
      description: "Create a queued export CommandPlan for a validated canonical sequence revision",
      scope: "book",
      schema: {
        book_id: z.string().uuid(),
        source_surface: z.enum(["ui", "slash", "chat"]),
        actor: z.string().min(1),
        ...exportSettingsSchema.shape,
      },
      handler: async (args) => {
        const settings = args as unknown as z.infer<typeof exportSettingsSchema>;
        const validation = await validateSequenceExport(engine, settings);
        if (!validation.valid) return json({ kind: "invalid-export", validation });
        const planId = uuidv7();
        return json({
          planVersion: 1,
          planId,
          sourceSurface: args.source_surface,
          actor: args.actor,
          bookId: engine.book.get().bookId,
          summary: `Export ${validation.orientation} MP4`,
          normalizedReferences: [{
            kind: "sequence",
            targetId: validation.sequenceId,
            revision: validation.revision,
          }],
          stages: [
            {
              stageId: `${planId}:export:0`,
              kind: "export",
              summary: "Validate final render settings",
              sequenceId: validation.sequenceId,
              revision: validation.revision,
              orientation: validation.orientation,
              captions: validation.captions,
            },
            {
              stageId: `${planId}:queued:1`,
              kind: "queued",
              summary: "Render H.264/AAC MP4",
              jobType: "export",
              tool: "export_sequence",
              input: {
                sequence_revision: validation.revision,
                orientation: validation.orientation,
                captions: validation.captions,
                width: validation.width,
                height: validation.height,
                input_object_hashes: validation.inputObjectHashes,
              },
              insertsOutput: false,
            },
          ],
          confirmation: {
            required: true,
            policy: "always",
            reason: "Export runs as a queued render against this exact revision",
          },
          validation,
        });
      },
    },
    {
      name: "enqueue_sequence_export",
      description: "Queue a confirmed canonical sequence export after revalidating its exact revision",
      scope: "book",
      schema: {
        book_id: z.string().uuid(),
        confirm: z.literal(true),
        ...exportSettingsSchema.shape,
      },
      handler: async (args) => {
        const settings = args as unknown as z.infer<typeof exportSettingsSchema>;
        const validation = await validateSequenceExport(engine, settings);
        if (!validation.valid) return json({ kind: "invalid-export", validation });
        const jobId = `export-sequence-${engine.book.get().bookId}-${uuidv7()}`;
        await queue.enqueue(jobId, {
          type: "export_sequence",
          bookId: engine.book.get().bookId,
          sequenceRevision: validation.revision,
          orientation: validation.orientation,
          captions: validation.captions,
        });
        return json({
          status: "enqueued",
          jobId,
          sequenceId: validation.sequenceId,
          sequenceRevision: validation.revision,
          orientation: validation.orientation,
          captions: validation.captions,
        });
      },
    },
  ];
}
