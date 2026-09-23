# Music rhythm analysis

The fullscreen timeline and `/music-video` use the same editor and canonical sequence. The soundtrack controls select the master clip, analyze its audio, and let the user confirm or correct its beat map. The timeline draws a source-aligned waveform, beat guides, and distinct bar starts. Unknown meter stays unknown. Snapping can be off, on beats, or on confirmed bars. New footage keeps its source speed; stretching and draft retiming are explicit choices.

When beats are available but bar starts are unknown, selecting Bars opens bar setup and focuses beats per bar. Existing snapping remains active until the user sets the meter and anchors a bar at the playhead; then Bars snapping activates. Bar grouping preserves beat timestamps and uses the detected tempo to count gaps from missed beats, so later bars keep their phase. The user can review and correct these estimates.

Drafts use selected footage in the displayed order and a selected soundtrack range. Preview and Cancel do not mutate the saved sequence. Apply uses one canonical edit action. Keep existing clips is enabled initially; boundary-crossing clips and explicitly preserved clip IDs survive replacement. Locked tracks cannot be targeted. A draft with uncovered spans cannot be applied from the editor. Video removal and trimming leave the soundtrack in place. Fit is the shared preview/export default; explicit Fill and Crop transforms remain authoritative.

## Analysis contract

`analyze_music` starts or reuses a queued job. `get_music_analysis` returns missing, queued, analyzing, ready, no-beats, cancelled, or failed, plus any valid previously cached result. Decode failure and cancellation never create a successful empty result. Decode and tracking run in a cancellable child process; waveform extraction streams through FFmpeg. There is a 60-minute source-duration limit.

The cache key includes the current source object hash, audio stream index, analyzer identifier, and algorithm version. Results include source-second beat positions, confidence, optional bar starts and meter, duration, and at most 8,192 waveform buckets. Source identity is checked before analysis and again before persistence. Replacing source bytes invalidates the cache.

`get_sequence_rhythm` and `update_sequence_rhythm` persist a master clip and a separately versioned correction layer in engine book metadata. Updates require the rhythm revision and support independent undo/redo. Corrections survive reanalysis and reopen. Source seconds are projected through the clip's trim, offset, reverse flag, rational speed and sequence frame rate, then rounded once for display/editing. Duplicate frame positions are collapsed, retaining bar starts. The existing player cannot audition reversed audio; the Soundtrack panel explains that limitation. Reverse timing is mapped for markers and rendered in the export.

`plan_music_video` returns a CommandPlan, engine preview, proposed sequence, source ranges, rates, uncovered spans, and both rhythm and sequence-content revisions. `commit_music_video` checks those revisions and the engine preview/source checks, then commits through `engine.edits`. It serializes against rhythm edits and identifies prior commits by command ID in engine history, so retries return the original action without inserting duplicate clips. Generic edit commits permit metadata rebasing and do not provide this retry behavior; the guarded music endpoint is required for applying a music draft.

## Detector decision and limits

The initial backend is the existing TypeScript spectral-flux/dynamic-programming prototype, hardened with streaming decode, worker isolation, cancellation, source fences, bounded payloads and conservative confidence handling. It requires Node and the project's existing FFmpeg, with no model download, provider key or network call. Onset autocorrelation proposes tempo; dynamic programming follows supported attacks rather than writing a uniform BPM grid. Heuristic accent grouping only produces bars after sufficient repeated evidence. Short and octave-ambiguous results require listening and confirmation before automatic drafting.

[Librosa 0.11.0](https://librosa.org/doc/0.11.0/generated/librosa.beat.beat_track.html) was tested as an independent reference. It also uses onset strength, autocorrelation and dynamic programming, and supports supplied time-varying tempo. It is not a runtime dependency. [Essentia RhythmExtractor2013](https://essentia.upf.edu/reference/std_RhythmExtractor2013.html) was considered for its multifeature tracker and confidence output; its native deployment and [licensing terms](https://essentia.upf.edu/licensing_information.html) would require a separate integration decision.

Version 2 preserves uncertain candidates when tempo passes the periodicity check and at least eight attacks support the tracked rhythm, even if their average strength is low relative to the loudest transient. These candidates remain marked low-confidence, do not infer bars, and require confirmation or correction before automatic drafting. Short weak results, silence and unstructured noise remain rejected. The versioned cache prevents reuse of version 1's empty results.

The synthetic fixtures cover several tempos, leading silence, silence, speech-like noise, unstructured noise, syncopation, accented triple meter, harmonic interference, changing loudness and changing tempo. These are regression tests, not evidence of broad accuracy on commercial music.

An independently annotated 2.8-second excerpt from [madmom's test fixtures](https://github.com/CPJKU/madmom/tree/main/tests/data) exposed a metrical ambiguity: this backend and librosa each matched only 2 of 4 annotated beats within 70 ms (F1 0.40). The native result is now flagged uncertain rather than accepted automatically. The excerpt was used locally for evaluation and is not redistributed; [madmom's data/model license](https://github.com/CPJKU/madmom/blob/main/LICENSE) differs from its code license. This small comparison does not establish genre-level accuracy. Difficult songs may need the manual BPM/phase grid or individual marker corrections; detected BPM and bar estimates are not ground truth.

## Reproducible performance check

Run `npx tsx scripts/benchmark-rhythm.ts` for generated 120 BPM audio at 67 seconds, 5 minutes and 30 minutes. To measure an independently annotated local file, use `npx tsx scripts/benchmark-rhythm.ts input.wav annotations.beats`; annotation rows start with seconds and may include a beat number. Inputs remain outside managed book storage. The script reports runtime, worker RSS, retained analysis samples, parent event-loop delay and one-to-one beat precision/recall/F1 at 70 ms tolerance.

Observed on Apple M1 Pro, macOS arm64, Node 24.10.0, September 22, 2026:

| Input | Decode + tracking | Worker peak RSS | Parent maximum delay | Beat F1 | Median timing error |
| --- | ---: | ---: | ---: | ---: | ---: |
| 67 seconds | 0.28 s | 100 MiB | 3.2 ms | 1.00 | 3.7 ms |
| 5 minutes | 0.85 s | 101 MiB | 7.9 ms | 1.00 | 3.7 ms |
| 30 minutes | 3.56 s | 111 MiB | 2.5 ms | 1.00 | 3.7 ms |

These timings exclude the separate waveform extraction and persistence phases. The worker retains at most one FFT window of PCM between decode chunks; its onset envelope grows with duration. The 30-minute worker's longest measured event-loop delay was 92 ms, isolated from the parent. Automated worker tests cover multi-minute IPC output, cancellation and invalid decoding.

## Validation

The integration tests exercise current-source cache invalidation, job deduplication, persistence, concurrent correction conflicts, undo/redo, rational source-time projection, deterministic drafts, gaps, source limits, locked tracks, stale rhythm rejection and commit retries. The browser scenario uses the real MCP server and real generated media across five viewport sizes. The export regression decodes the resulting video and PCM to check cut frames, portrait edges, padding and the onset of a trimmed, offset soundtrack.
