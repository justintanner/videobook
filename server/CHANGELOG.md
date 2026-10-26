# Changelog

All notable changes to the `videobook` npm package are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A TikTok-style subtitle editor in the chat composer. `/subs @video`, a
  video cell's Subtitles menu item, or asking chat or voice for subtitles
  opens it beside the chat: a portrait preview that plays with audio and
  highlights each spoken word, an editable transcript (text, timing, hidden
  and inserted words, phrase splits and joins), style, size, colours,
  outline, padding, language, frame and timing controls, and a draggable,
  keyboard-adjustable vertical position for all phrases or one. Drafts save
  as you edit, export to SRT or WebVTT, and Render creates a new subtitled
  video cell below the source (later renders become versions of it). The
  source video is never changed.
- `caption_video` MCP tool with `op: get | prepare | update | render`. `get`
  reads the draft and preparation status without starting work (`detail:
  full` adds the document, face/text regions and loudness envelope);
  `prepare` starts word-timed transcription, vocal timing, optional face
  and on-screen-text placement and translation; `update` saves edits, a
  replacement document or a resolution (`reseed`, `realign`,
  `keep_timings`, `discard`) against `expected_revision`; `render` takes the
  reviewed revision, `source_hash` and a stable `request_id` and returns the
  same job on retries. Only `prepare` spends money.
- Caption analysis is keyed by content: repeated or concurrent requests reuse
  one job, cached results return without provider calls, a failed refresh
  keeps the last result, and results for a video that changed mid-analysis
  are discarded. Subtitles render with bundled Montserrat and Anton (OFL),
  load Noto Sans subsets on demand for other scripts, and handle
  right-to-left text.
- `force` on `transcribe`, `translate_subtitles`, `describe_image`,
  `detect_scenes`, `suggest_cuts`, `suggest_sfx` and `analyze_jokes`
  (`analyze_video` already had it) to run again on unchanged inputs.

### Changed

- Every analysis tool is keyed by the content it reads: speech-to-text by the
  transcribed audio and settings, translations by the timed transcript and
  language, video analysis by the video and the transcript it used, image
  descriptions by the image, scene scans by the video, cut and sound-effect
  suggestions by the video, transcripts, analysis and instructions, and joke
  analysis by the timed transcript. A repeat returns `status: "cached"`
  (suggestions and jokes include the earlier entries) without a provider
  call, a job or a write; otherwise the tools return `queued` or `running`
  with a numeric `job_id`, and concurrent or forced requests join one job.
  These tools no longer return `enqueued`, `already_analyzed` or string job
  ids.
  Automatic transcription and analysis jobs skip the provider when their
  result is current, results whose inputs changed mid-run are discarded, a
  failed refresh keeps the previous result, and undoing an edit serves the
  earlier analyses again. Sidecars written by earlier versions are adopted
  once instead of being paid for again.
- `describe_image` returns the script asset it already wrote for an unchanged
  image instead of creating a new one per call.
- Captions, keyword titles and watermark placement share one cache of face
  and on-screen-text regions per video frame, so each pass only sends frames
  no earlier pass analysed.
- A render with a translated `subtitle_language` fails with the reason when
  the translation cannot be made, instead of burning the original language.
- Editing a video's picture or sound still deletes its video analysis and,
  for sound or timing edits, its transcripts; scene scans, suggestions and
  joke analyses are kept and simply stop matching the edited media.
- Thai, Lao, Khmer, Burmese, Chinese and Japanese speech is read as words.
  ElevenLabs returns these scripts a letter at a time; transcripts,
  subtitles, SRT exports, the transcript card and translations now join the
  letters into dictionary words without spaces between them, and a space in
  Thai ends a subtitle phrase so it is never silently dropped. Subtitle
  phrases are measured by visible width (Thai vowel and tone marks take
  none, CJK characters take two), the seven-word cap applies only to spaced
  scripts, and a clause too long for one phrase splits into the fewest even
  phrases. Translations from Thai send whole clauses to the translator, and
  translations into these languages time real words instead of character
  pairs. Saved subtitle drafts with letter-by-letter Thai are regrouped into
  words when they load, keeping corrections, styling and manual phrase
  breaks. Caption vocal timing is measured again once per video for the new
  words.

- `/alive` opens the new subtitle editor. Saved Alive caption settings seed
  the editor's style, a matching saved Alive analysis is reused instead of
  being paid for again, stored renders that still use the `alive` subtitle
  style render through the new captions, and queued `analyze_alive_captions`
  jobs run caption preparation.
- `render_video` and `render_project` no longer accept `highlight_style:
  "alive"`; use `caption_video` for word-timed subtitles.

### Removed

- The `alive_captions` and `set_alive_captions` MCP tools and the
  full-screen Alive captions studio. Use `caption_video` and the subtitle
  editor instead.

## [0.3.2] - 2026-10-26

### Added

- The KIE Grok Imagine Video 1.5 preview's 1080p tier, priced at $0.04 per
  second. At 1080p it takes exactly one image (`image_urls`); 480p and 720p
  still take more.

### Changed

- Every `@apicity` package is at 0.19.0.
- The KIE Grok Imagine Video 1.5 preview defaults to 1080p, its highest
  resolution, as `kie:grok-imagine/image-to-video` already does. A request
  with more than one image needs 480p or 720p and is refused before
  anything is spent.
- The KIE Grok Imagine Video 1.5 preview sends `nsfw_checker: false` by
  default, the default KIE documents and every other KIE video model with
  the setting already sends. 0.3.1 sent `true`; pass `nsfw_checker: true` to
  keep KIE's content filter on.
- KIE Seedance 2.5 keeps generating audio by default. apicity 0.19.0 now
  defaults `generate_audio` to `false`, but Videobook still sends `true`
  unless a request turns audio off.
- MachGen estimates follow the 0.19.0 pricebook. A MiniMax H3 run with a
  first and a last frame is priced at the image-to-video rate ($0.035 per
  second at 480p instead of $0.05), and Wan 3.0 references that include a
  video add the reference video's seconds to the output's.
- KIE OmniHuman 2.0 generations turn KIE's watermark off by default
  (`enable_watermark: false`); pass `enable_watermark: true` to keep it.
  OmniHuman 2.0 videos generated with 0.3.1 carry the watermark. OmniHuman
  1.5 has no watermark option.

### Fixed

- A catalog model the installed apicity packages cannot resolve no longer
  fails the whole model listing, which left every book looking empty on
  load. The listing skips that model and logs a `model-unresolvable`
  warning naming it.
- Queued KIE OmniHuman 1.5 and 2.0 generations pass their driving audio's
  length to the cost estimate, so the KIE paygate estimate is bounded and the
  usage row is priced.
- Queued KIE HappyHorse video edit and Kling 3.0 motion control generations
  pass their source video's length, and Volcengine lip sync passes its audio's
  length, so their paygate estimates and usage rows are priced too.
  `estimate_cost` now prices Volcengine lip sync from the audio, whose length
  the output follows, instead of the source video.
- The usage counter groups each catalog generation under its catalog media.
  34 KIE and fal models, among them OmniHuman, the HeyGen digital twins, the
  Gemini and ElevenLabs speech models and the Bria image models, were counted
  as analysis, and fal Wan 2.7 image edit as video.
- KIE Suno music and sound generations now reach the usage counter as audio,
  priced at KIE's flat rate per generation: $0.06 for music and $0.0125 for
  sounds. Their status polls settle the row: a lyrics-only result stays
  pending, and a failed generation is not counted as spend.
- KIE generations stay pending in the usage counter until their task
  settles. A queuing or generating KIE task, or a Veo task that is still
  generating, was counted as settled spend at its first status poll, and a
  Veo generation that failed while generating (`successFlag` 3) was counted
  as completed spend.
- A Veo generation that fails while generating now fails with KIE's error
  message at the next status poll. It was treated as still processing and
  polled until the pending-task timeout.

## [0.3.1] - 2026-10-25

### Added

- KIE Kling 4.0 reference-to-video and keyframe-to-video, 3 to 30 seconds at
  720p or 1080p. Reference-to-video takes up to ten images and five videos,
  and generates from the prompt alone when none are connected. Keyframe-to-video
  takes a first frame, up to eight middle keyframes and a last frame, as many
  as the duration allows. Prompts name connected media the way Kling 4.0 does:
  `@image_1`, `@video_1`, `@first_frame`, `@keyframe_1` and `@last_frame`.
- KIE PixVerse V6 Max text-to-video and image-to-video, 1 to 15 seconds at
  360p to 1080p, with optional generated audio and a seed. Image-to-video
  follows the image's aspect ratio.
- KIE OmniHuman 2.0, which animates one image to a driving audio track at 720p
  for as long as the audio runs, with an optional prompt of up to 300
  characters. KIE's watermark stays on by default (`enable_watermark`).
- The KIE Grok Imagine Video 1.5 preview, the KIE Grok Imagine endpoint that
  takes first and last frames, a loop image (`loop_url`) and up to four timed
  `keyframes`. It shares the Grok Imagine Video 1.5 image-to-video frontier
  ranking. Kling 4.0, PixVerse V6 Max and OmniHuman 2.0 are on no top-10 board
  and appear in the unranked group.

### Changed

- Upgrade all `@apicity/*` dependencies to 0.18.1, which prices the new KIE
  models. Its endpoint catalog now lists fal `v1.queue.status` and
  `v1.queue.result`, with the other fal SDK methods written as method
  shorthand, so `apicity har report` from `@apicity/cli` 0.18.1 can resolve the
  fal polling captures Videobook writes. The requests sent to fal are
  unchanged.
- Image and video models default to a 12-second duration (or the nearest
  allowed length), a 9:16 aspect ratio and their highest resolution, quality
  and bitrate. Each notebook remembers the last duration, aspect ratio,
  resolution and quality a cell used, and applies them to new cells and model
  switches. Goals saved before this change keep their 2K scene; new goals use
  4K.
- On desktop, Settings shows AI providers in one column and accounts, storage
  and diagnostics in another; on phones the columns stack behind section jump
  buttons. The chat input stays a plain bar on Settings.
- The Library opens from an Assets button in the notebook toolbar instead of
  the header, and Arrange is renamed Clean.
- Library browsing pages assets before building their rows and no longer runs
  ffprobe while listing; proxy checks and duration backfills run as background
  jobs.
- A Post can take its published link without being saved to iPhone or Dropbox
  first.

### Fixed

- HAR captures of KIE's nested Veo and Suno SDK calls are named by their
  apicity catalog dot paths, such as `api.v1.veo.generate` and
  `api.v1.generate.sounds`, instead of their SDK paths, so `apicity har report`
  resolves them. Sub-provider prefixes that are URL segments stay:
  `kie.claude.post.v1.messages` is named `claude.v1.messages`.
- A generation that fails before reaching its provider, such as a request the
  schema refuses, is captured under the provider's catalog endpoint, and fal,
  Alibaba and KIE file uploads are captured as `storage.upload.initiate`,
  `api.v1.uploads` and `api.fileStreamUpload`, so `apicity har report` resolves
  them.
- A notebook generation whose provider fails after accepting the request now
  marks its plan failed with the provider error. `list_notebook_generation_plans`
  and the Jobs screen kept reporting such plans as awaiting output.
- v3 goals saved with a 2K scene load again and keep that resolution when they
  are edited, approved or retried.
- Image subject edits check the provider key before uploading the source image,
  so a missing or placeholder key no longer sends the image to a public file
  host for a request that cannot run.
- Settings loads when the page opens on it, or when it opens before the MCP
  connection is ready.
- The multyculty workflow and video poster recovery tests no longer time out on
  loaded hosts, and the chat-composer browser test no longer reads the runner's
  `.env` or provider keys and matches the ranked model picker.

## [0.3.0] - 2026-10-24

### Added

- Opt-in local provider HAR diagnostics with Settings, MCP and CLI controls, concurrent book attribution and retention limits.
  Captured SDK calls are named by their apicity catalog dot path, such as
  `api.v1.jobs.createTask`, so `apicity har report` attributes them to their
  endpoints.
- The Request payload panel of a queued, generating or failed cell downloads
  the attempt's scrubbed captures as one HAR file, or shows "Capture off" with
  a link to Settings. `inspect_generation_request` reports whether an asset has
  a capture, with its path and outcome; the new `get_generation_har` tool
  returns the HAR for an asset or attempt id.
- `videobook har list` and `videobook har export --out <dir|file.tar.gz>`,
  both with `--since`, `--failures` and `--provider`. Export re-runs the
  `@apicity/har` scrubber on every capture and refuses, naming the file, when
  scrubbing would change it. Otherwise it writes the captures with an index
  and a manifest and prints the `apicity har report` hand-off.

### Changed

- Upgrade all Apicity dependencies to 0.18.0.

## [0.2.5] - 2026-10-24

### Added

- Thirteen fal video endpoints: Kling 4 text, frame, reference and editing;
  HeyGen Video text, image and reference generation; HeyGen Avatar 3/4/5
  stock digital twins, Avatar 4 image animation, and Video Agent v2/v3.
- HeyGen Video text and reference models appear in the ranked pickers.
  Kling 4 appears in the unranked group. Digital twins accept spoken scripts
  with stock avatar and voice defaults; Avatar 4 image animation defaults to Ivy.

### Changed

- Upgrade all Apicity packages to 0.17.1 and refresh generated model documentation.

## [0.2.4] - 2026-10-23

### Added

- Image and video model pickers show frontier rankings from the offline
  `@apicity/cost` snapshot, with rank, Elo and price for the selected operation.
  Other models follow in their existing order; unconfigured providers are
  marked unavailable. Saved selections and default models stay unchanged.

- MachGen as a video provider, with six models: MiniMax H3, Seedance
  2.5, Seedance 2.0, Wan 3.0 and HappyHorse 1.1 for text, frame and
  reference video, and Grok Imagine Video 1.5 for image-to-video. Each
  model offers its own resolutions, durations and aspect ratios, and
  cost estimates come from the `@apicity/cost` MachGen per-second rates.
  Wan 3.0 always sends MachGen's documented adaptive, 30 fps, with-audio
  config. Generations run as provider tasks: Videobook polls MachGen and
  downloads the finished video with the API key.
- `MACHGEN_API_KEY` is a managed key. `videobook config`, 1Password
  resolution and the provider keys panel include it. Without it, MachGen
  generations stop with "MACHGEN_API_KEY environment variable is not set"
  before an asset is created, and pending MachGen tasks wait unpolled.
- Seedance 2.5 Draft Complete (`kie:bytedance/seedance-2-5-draft`)
  renders the 1080p final of a 480p Seedance 2.5 draft from the draft's
  Kie task id. A draft rendered in the same book supplies the billed
  seconds and reference video seconds for the estimate. The Kie Seedance
  2.5 model gains the matching `draft` option.

### Changed

- Upgrade all application `@apicity/*` dependencies to 0.17.0 and add
  `@apicity/machgen`.
- Kie Seedance 2.5 estimates use the 2026-10-22 rates, for example
  $0.79 per second at 1080p without a reference video, up from $0.57.

## [0.2.3] - 2026-10-21

### Added

- Fal FLUX 3 Max text-to-video, image-to-video, and keyframes-to-video,
  with generated audio and resolution-tiered per-second cost estimates.
- Bria Fibo 2 text-to-image with structured VGL prompts, and Fibo 2 Edit
  for one to four reference images, including the image editor.
- H3 Max Reframe Video, which outpaints a source video to a target aspect
  ratio at 480p, 768p, or 1080p while keeping its audio and timing.
  Priced from fal's historical average because the request does not fix
  the billed duration.

### Changed

- Upgrade all application `@apicity/*` dependencies to 0.16.3.
- Windows x64 is supported. The release check runs the pack-and-install
  smoke on Windows and blocks the release when it fails. Stopping
  `videobook serve` from another process still ends it without a clean
  shutdown, because Windows has no SIGTERM, and the next start replaces
  the lock file.
- Dynamic fal requests are priced from fal's historical average when
  `FAL_ADMIN_API_KEY` is set. Without the key, and for the two Seedance
  formula gaps, the estimate stays at the local $0.

## [0.2.2] - 2026-10-21

### Added

- KIE FLUX 3 Klein text-to-image and image editing, with 1K defaults,
  up to ten edit references, and resolution-aware per-image cost estimates.
- FLUX 3 Klein Edit in the image editor for whole-image and region edits.

### Changed

- Upgrade all application `@apicity/*` dependencies to 0.16.2.

### Fixed

- Accept npm 12 workspace pack results in the installed-package smoke gate.

## [0.2.1] - 2026-10-20

### Changed

- Upgrade to videobook-engine 5.7.1 with official DoltLite 0.51.1 for
  concurrency, reopened-catalog allocation, schema-conflict recovery, and
  ignored AUTOINCREMENT sequence fixes. Existing 0.50.9 books retain their
  format and engine schema.

## [0.2.0] - 2026-10-19

### Added

- `videobook config` lists where every provider key comes from, with secret
  values masked; `config get`, `config set` and `config unset` edit the
  data-home `.env` atomically.
- 1Password support: `op://` references in the environment or `.env` resolve
  through the 1Password CLI when a server starts, and
  `videobook setup 1password --op-vault <vault>` reads every key from a vault
  whose items are named after the keys. `videobook doctor` reports the setup
  and which keys 1Password supplied.
- `VIDEOBOOK_YTDLP_PATH` selects the yt-dlp binary.
- `list_jobs` accepts `job_keys`, the `job_id` strings other tools return.

### Changed

- ffprobe now comes from `@ffprobe-installer/ffprobe`, which installs one
  native build for the current platform instead of `ffprobe-static`'s builds
  for every platform. Apple Silicon and Linux arm64 get a bundled ffprobe, and
  the install is about 300 MB smaller. When npm skips the package's chmod
  script, videobook marks the binary executable itself.
- The npm page no longer links to the private source repository, which
  anonymous visitors cannot open; its homepage is the npm package page.
- The README states that Windows is not supported yet, and why, instead of
  calling it untested.

### Fixed

- Downloading videos from URLs works when npm blocked the yt-dlp download:
  videobook falls back to `yt-dlp` on `PATH`, passes yt-dlp the resolved
  ffmpeg so format merges work, and fails with install instructions when no
  yt-dlp exists. `videobook doctor` shows which yt-dlp is used.
- `videobook run` waits for queued jobs on an already running server too,
  instead of returning while the job runs, and reports how the job ended.

## [0.1.0] - 2026-10-19

### Added

- `videobook` command-line interface: `serve` runs the MCP server with the
  bundled web UI (or `--headless` for MCP and API only), `mcp` serves MCP over
  stdio for agent hosts, `run` and `tools` call MCP tools from the shell,
  `gc-books` reclaims catalog storage, and `doctor` checks the local
  environment.
- Installed data defaults to `~/.videobook`, overridable with `VIDEOBOOK_HOME`.
