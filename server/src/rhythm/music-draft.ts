import { withNotebookMutation } from "../notebook-mutations.js";
import { v5 as uuidv5 } from "uuid";
import { findPrimaryMediaFile, MVP_CONTRACT_VERSION, type Engine, type EditOperation, type SequenceClip, type SourceSurface, type TimedSequenceClip } from "videobook-engine";
import { sequenceContinuationRevision } from "../tools/command-plan.js";
import { cachedMusicAnalysis, musicSource } from "./music-analysis.js";
import { readSequenceRhythm } from "./sequence-rhythm.js";
import { effectiveMarkers, soundtrackClip, timelineMarkers } from "./timing.js";
import { musicDraftOptionsSchema, type MusicDraftOptions, type MusicVideoDraft } from "./draft-model.js";
import { fittedTransform } from "./visual-fit.js";

const namespace = "5cc43cf4-f4bf-4dce-aa1e-a8105ae53087";
const endOf = (clip: SequenceClip) => clip.timelineStartFrame + clip.durationFrames;

export async function planMusicVideo(engine: Engine, input: MusicDraftOptions, expectedSequence: string, expectedRhythm: string, actor: string, sourceSurface: SourceSurface): Promise<MusicVideoDraft> {
  const options = musicDraftOptionsSchema.parse(input);
  const sequence = engine.sequences.getPrimary();
  const contentRevision = sequenceContinuationRevision(sequence);
  if (contentRevision !== expectedSequence && sequence.revision !== expectedSequence) throw new Error("The timeline changed. Reload before making a draft.");
  const rhythm = await readSequenceRhythm(engine, sequence.sequenceId);
  if (rhythm.revision !== expectedRhythm) throw new Error("The beat map changed. Reload before making a draft.");
  const master = soundtrackClip(sequence, rhythm.settings);
  if (!master) throw new Error("Choose a master soundtrack before making a draft.");
  const source = await musicSource(engine, master.source.artifactId, master.source.range.streamId);
  if (source.objectHash !== master.source.range.objectHash) throw new Error("The soundtrack source changed. Replace the timeline clip first.");
  const analysis = await cachedMusicAnalysis(engine, source);
  if (!rhythm.settings.correction && (!analysis || analysis.lowConfidence)) throw new Error("Analyze the song and confirm uncertain beats with a manual grid before making a draft.");
  const markers = timelineMarkers(master, effectiveMarkers(master, rhythm.settings, analysis), sequence);
  const musical = markers.filter((marker) => options.unit === "beats" || marker.bar);
  if (musical.length < 2) throw new Error(options.unit === "bars" ? "Confirm bar starts in Soundtrack before using bars." : "Add at least two beat markers before making a draft.");
  const track = sequence.tracks.find((item) => item.trackId === options.track_id);
  if (!track || track.kind !== "video" || !track.enabled || track.locked) throw new Error("Choose an enabled, unlocked video track.");
  if (options.start_frame >= options.end_frame || options.start_frame < master.timelineStartFrame || options.end_frame > endOf(master)) throw new Error("Choose a nonempty range inside the master soundtrack.");
  const touching = sequence.clips.filter((clip) => clip.trackId === track.trackId && clip.timelineStartFrame < options.end_frame && endOf(clip) > options.start_frame);
  const preserved = touching.filter((clip) => options.preserve_existing || options.preserve_clip_ids.includes(clip.clipId) || clip.timelineStartFrame < options.start_frame || endOf(clip) > options.end_frame);
  const removed = touching.filter((clip) => !preserved.includes(clip));
  if (sequence.transitions.some((transition) => removed.some((clip) => transition.outgoingClipId === clip.clipId || transition.incomingClipId === clip.clipId))) throw new Error("Remove transitions in the replacement range or keep the existing clips.");
  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = options.start_frame;
  for (const clip of [...preserved].sort((a, b) => a.timelineStartFrame - b.timelineStartFrame)) {
    if (clip.timelineStartFrame > cursor) gaps.push({ start: cursor, end: Math.min(clip.timelineStartFrame, options.end_frame) });
    cursor = Math.max(cursor, endOf(clip));
  }
  if (cursor < options.end_frame) gaps.push({ start: cursor, end: options.end_frame });
  if (!gaps.length) throw new Error("This range is already filled. Turn off Keep existing clips to replace it, or choose an empty range.");
  const fps = sequence.frameRate.numerator / sequence.frameRate.denominator;
  const sources = await Promise.all(options.sources.map(async (selection) => {
    const artifact = engine.artifacts.get(selection.artifact_id);
    if (!artifact.ok || !["video", "final"].includes(artifact.value.kind)) throw new Error("Choose ready video sources.");
    const manifest = await engine.files.manifest(selection.artifact_id);
    const streams = engine.streams.list(selection.artifact_id);
    if (!manifest.ok || !streams.ok) throw new Error("A source is unavailable. Refresh media.");
    const file = findPrimaryMediaFile(manifest.value.files, artifact.value.kind);
    const stream = streams.value.find((item) => item.kind === "video" && item.objectHash === file?.objectHash && item.sourcePath === file.name);
    if (!stream) throw new Error(`Wait for ${artifact.value.label} to finish processing.`);
    const tickSeconds = stream.timeBase.numerator / stream.timeBase.denominator;
    const first = Math.round((selection.start_seconds ?? 0) / tickSeconds);
    const last = selection.end_seconds === undefined ? stream.durationTicks : Math.round(selection.end_seconds / tickSeconds);
    if (first < 0 || last > stream.durationTicks || first >= last) throw new Error(`Source range is outside ${artifact.value.label}.`);
    return { artifactId: selection.artifact_id, stream, tickSeconds, first, last, used: first };
  }));
  if (new Set(sources.map((item) => item.artifactId)).size !== sources.length) throw new Error("Select each source once; enable source reuse to repeat footage.");
  const snapshot = engine.head;
  const currentRhythm = await readSequenceRhythm(engine, sequence.sequenceId);
  if (snapshot !== engine.head || currentRhythm.revision !== rhythm.revision || sequenceContinuationRevision(engine.sequences.getPrimary()) !== contentRevision) throw new Error("The timeline or beat map changed while planning. Try again.");
  const commandId = uuidv5(JSON.stringify([snapshot, rhythm.revision, options, sources.map((item) => item.stream.objectHash)]), namespace);
  const operations: EditOperation[] = removed.map((clip) => ({ kind: "remove-clip", clipId: clip.clipId, ripple: false }));
  const inserted: TimedSequenceClip[] = [];
  const shots: MusicVideoDraft["shots"] = [];
  const uncovered: MusicVideoDraft["uncovered"] = [];
  const warnings = new Set<string>();
  let sourceIndex = 0;
  const intervalFrames = musical.filter((_, index) => index % options.interval === 0).map((marker) => marker.frame);
  for (const gap of gaps) {
    const boundaries = [gap.start];
    for (const frame of intervalFrames) {
      if (frame - boundaries[boundaries.length - 1]! >= options.minimum_shot_frames && gap.end - frame >= options.minimum_shot_frames) boundaries.push(frame);
    }
    boundaries.push(gap.end);
    for (let index = 1; index < boundaries.length; index++) {
      if (shots.length >= 1000) throw new Error("Limit the draft to 1,000 shots; choose a longer interval or shorter range.");
      const start = boundaries[index - 1]!;
      const end = boundaries[index]!;
      const seconds = (end - start) / fps;
      let chosen: (typeof sources)[number] | undefined;
      let ticks = 0;
      let retimed = false;
      for (let attempt = 0; attempt < sources.length; attempt++) {
        const candidate = sources[(sourceIndex + attempt) % sources.length]!;
        const required = Math.ceil(seconds / candidate.tickSeconds - 1e-7);
        if (candidate.last - candidate.used >= required) { chosen = candidate; ticks = required; sourceIndex = (sourceIndex + attempt + 1) % sources.length; break; }
        if (options.reuse_sources && candidate.last - candidate.first >= required) { chosen = candidate; chosen.used = chosen.first; ticks = required; sourceIndex = (sourceIndex + attempt + 1) % sources.length; warnings.add("Some source footage is repeated."); break; }
      }
      if (!chosen && options.allow_retiming) {
        const candidate = sources[sourceIndex % sources.length]!;
        if (candidate.used === candidate.last && options.reuse_sources) { candidate.used = candidate.first; warnings.add("Some source footage is repeated."); }
        if (candidate.used < candidate.last) { chosen = candidate; ticks = candidate.last - candidate.used; retimed = true; sourceIndex = (sourceIndex + 1) % sources.length; }
      }
      if (!chosen) { uncovered.push({ startFrame: start, endFrame: end }); continue; }
      const clipId = uuidv5(`shot:${shots.length}`, commandId);
      const nativeFrames = ticks * chosen.tickSeconds * fps;
      const speed = retimed ? { numerator: Math.max(1, Math.round(nativeFrames * 1000)), denominator: (end - start) * 1000 } : { numerator: 1, denominator: 1 };
      const clip: TimedSequenceClip = {
        clipId, trackId: track.trackId, timelineStartFrame: start, durationFrames: end - start, enabled: true,
        source: { kind: "timed", artifactId: chosen.artifactId, range: { streamId: chosen.stream.streamId, objectHash: chosen.stream.objectHash, timeBase: chosen.stream.timeBase, startTick: chosen.used, durationTicks: ticks } },
        speed, reverse: false, audioPolicy: "mute", transform: fittedTransform(),
      };
      const { clipId: _id, enabled: _enabled, ...placement } = clip;
      operations.push({ kind: "insert-clip", clipId, mode: "overwrite", placement });
      inserted.push(clip);
      shots.push({ clipId, artifactId: chosen.artifactId, startFrame: start, endFrame: end, sourceStartSeconds: chosen.used * chosen.tickSeconds, sourceEndSeconds: (chosen.used + ticks) * chosen.tickSeconds, speed: speed.numerator / speed.denominator });
      chosen.used += ticks;
      if (retimed) warnings.add("Some shots change playback speed. Review each rate below.");
    }
  }
  if (!shots.length) throw new Error("No source is long enough for this interval. Choose shorter cuts, more footage, or explicitly allow retiming.");
  if (uncovered.length) warnings.add(`${uncovered.length} spans have no footage. Add footage, shorten the interval, or enable reuse before applying.`);
  if (!markers.some((marker) => marker.frame === options.end_frame)) warnings.add("The range ends between beats; the last shot ends exactly at your selected out point.");
  const intent = { intentVersion: MVP_CONTRACT_VERSION, commandId, sequenceId: sequence.sequenceId, baseRevision: snapshot, actor, sourceSurface, confirmationPolicy: "always" as const, operations };
  const preview = engine.edits.preview(intent);
  if (!preview.ok) throw new Error(preview.error.message);
  if (!preview.value.valid) throw new Error(preview.value.conflicts.map((conflict) => conflict.message).join("; "));
  const summary = `${shots.length} shots across ${((options.end_frame - options.start_frame) / fps).toFixed(2)}s`;
  return {
    plan: { planVersion: 1, planId: commandId, sourceSurface, actor, bookId: engine.book.get().bookId, summary,
      normalizedReferences: [{ kind: "sequence", targetId: sequence.sequenceId, revision: snapshot }, ...sources.map((item) => ({ kind: "artifact" as const, targetId: item.artifactId, objectHash: item.stream.objectHash }))],
      stages: [{ stageId: `${commandId}:edit:0`, kind: "edit", summary, intent }], confirmation: { required: true, policy: "always", reason: "Review the music-video draft before replacing footage" } },
    preview: preview.value, sequence: { ...sequence, clips: [...sequence.clips.filter((clip) => !removed.includes(clip)), ...inserted] },
    rhythmRevision: rhythm.revision, sequenceContentRevision: contentRevision, shots, uncovered, warnings: [...warnings, ...preview.value.warnings.map((warning) => warning.message)],
  };
}

export async function commitMusicVideo(engine: Engine, intent: import("videobook-engine").EditIntent, previewHash: string, rhythmRevision: string, sequenceContentRevision: string) {
  return withNotebookMutation(`rhythm:${engine.book.get().bookId}:${intent.sequenceId}`, async () => {
    const previous = engine.history.revisions(Number.MAX_SAFE_INTEGER).find((revision) => revision.operation === "commit_edit" && revision.details?.commandId === intent.commandId);
    if (previous) {
      if (previous.details?.previewHash !== previewHash) throw new Error("This draft ID was already applied with a different preview.");
      return { commandId: intent.commandId, actionId: String(previous.details.actionId), revision: engine.head,
        sequence: engine.sequences.getPrimary(), previewHash };
    }
    const rhythm = await readSequenceRhythm(engine, intent.sequenceId);
    if (rhythm.revision !== rhythmRevision) throw new Error("The beat map changed. Preview a new draft before applying.");
    if (sequenceContinuationRevision(engine.sequences.getPrimary()) !== sequenceContentRevision) throw new Error("The timeline changed. Preview a new draft before applying.");
    const committed = await engine.edits.commit(intent, previewHash);
    if (!committed.ok) throw new Error(committed.error.message);
    return committed.value;
  });
}
