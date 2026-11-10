# Changelog

All notable changes to the `videobook` npm package are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.1] - 2026-11-10

### Added

- `video_graphics` MCP tool with `op: get | update` for the on-screen
  graphics drawn over a video: text blocks, images, QR codes and shades, each
  with a position, size, opacity and time window. `get` reads the saved
  layers, or for a video without any the default look (the book's TikTok
  handle, an empty Thai title and an English line, no QR code), with the
  handle, profile URL and source credit that fill its slots and the starter
  layouts. `update` saves edits or a replacement document against
  `expected_revision` from `get`, and a stale revision comes back as a
  conflict that carries the current one. Saved graphics are not drawn into
  the video yet.

### Changed

- Gemini Omni references, Grok Imagine Video 1.5 references and Kling o3
  prompts name connected inputs with each provider's documented markers:
  `<IMAGE_REF_0>` and `<VIDEO_REF_0>` for Gemini Omni on fal and WaveSpeed,
  `<IMAGE_0>` for Grok 1.5 on fal, WaveSpeed and xAI, `<<<image_1>>>` and
  `<<<video_1>>>` for the Kling o3 edit on WaveSpeed, and `@Image1` and
  `@Video1` for Kling o3 on fal. Notebook prompts keep their `@image1` slot
  mentions.
- MachGen Topaz upscales are priced with MachGen's free quote instead of
  showing $0. `estimate_cost` and notebook plans quote an upscale of a MachGen
  output when `MACHGEN_API_KEY` is set, and every Topaz job is quoted when it
  submits, so its usage row keeps the quoted estimate beside the billed
  charge. A video MachGen must upload is quoted only at submission, and a
  failed quote leaves the estimate unpriced as before.
- Every @apicity package moves to 0.27.2. MiniMax H3 Max extend, insert and
  reference videos are quoted from their duration and resolution at the
  published per-second rate instead of fal's per-call average, so a 2K extend
  of 5 seconds quotes $1.60 and one of 15 seconds $4.80 instead of $0.32.
  Reference tokens are not counted, so the generation editor, plans, Jobs
  rows, chain steps and cell costs show the quote as "at least" the figure
  with the reason. H3 Max 3D and lip sync are quoted the same way when the
  source length is known. FLUX 3 Max video estimates follow fal's current
  promotion: $0.085 a second at 720p and $0.145 at 1080p.
- fal models quoted from fal's historical per-call average keep that quote
  beside the billed charge once fal reports the call's billable units, so cell
  and run totals set the estimate against the actual. The generation payload,
  plans, chain review and usage rows say the figure is a per-call average, not
  this request's price.
- Thai subtitles use a bundled Noto Sans Thai (OFL) instead of a subset
  downloaded from Google Fonts, so they render without network access.

### Fixed

- Subtitle renders, `render_video` and QR outros no longer fail on Linux hosts
  without an NVIDIA GPU. Remotion picked the `h264_nvenc` encoder there even
  without `libcuda`, so every render job failed; a render now falls back to
  software encoding when a hardware encoder cannot open and stays in software
  for the rest of the process, while hosts where hardware encoding works keep
  using it.
- A generation cell's cost breakdown no longer covers the Inputs, Model and
  Payload panels of its editor once the cell has three or more provider calls.
  The editor keeps its minimum height, and the per-call list is folded behind
  an "N calls" disclosure that scrolls inside the dock when opened. A cell
  with no recorded calls no longer shows an empty separator.
- A fal call that fal reports as 0 billable units, such as a request it
  rejects when the result is read, settles at $0.00 instead of staying at its
  quote for good, so cell, run and book totals are no longer left partial. A
  failed call shows as "Failed, not billed" with fal's reason, the book usage
  list says "Not billed", and `list_jobs` returns each job's `notBilledCalls`.
- A fal result that comes back without its billable units, as when it is read
  hours after the job finished, labels that call "Awaiting bill" instead of
  "Estimate". A later read that carries the units still sets the actual
  charge.
- A fal generation no longer fails for good when a status or result check
  answers 408, 429 or 499. The task stays pending for the next check, as
  MachGen and WaveSpeed tasks already did; other 4xx answers still fail it.

## [0.5.0] - 2026-11-09

### Added

- Usage costs set the quoted estimate beside the actual for each notebook
  cell, run and job. The cell inspector shows a cell's cost and, while it
  runs, the run's, call by call, with usage-only, free and unavailable calls
  explained. A total is marked partial while a call is unsettled or unpriced.
  Job rows and the book usage popover show the estimate against the actual.
  `get_book_usage` returns these totals and takes `scope.cell_id` or
  `scope.run_id` for one cell or run, and `list_jobs` includes each job's
  usage totals.

- WaveSpeed adds nine models: Seedance 2.0 References and Edit, Wan 2.7 Edit,
  HappyHorse 1.1 References, HappyHorse 1.0 Edit, Gemini Omni 1.1 Flash
  References, Grok Imagine Video 1.5 References, Kling o3 Pro Edit and Runway
  Aleph 2 Edit. Runway Aleph 2 takes a first frame, a last frame and timed
  keyframes. Estimates for the edits and Seedance 2.0 reference videos use the
  connected videos' durations.

- The MachGen Topaz upscale models can upscale any book video, not only
  MachGen's own outputs. The job sends the source through MachGen's upload,
  and sources of 32 MiB or more are refused before any MachGen call.

### Changed

- Video edits, lip sync, upscale and motion control no longer default to a
  9:16 aspect. Those models leave aspect unset, so a provider that follows an
  omitted aspect keeps the source framing. An explicit setting or a remembered
  notebook aspect still wins. Text, image and reference generation, and the
  explicit reframe models, still default to 9:16.

### Fixed

- fal's H3 Max edit and extend models no longer fail with a 422 when the
  source video is over 50 MiB. A larger source is re-encoded to H.264 under
  the cap, keeping its resolution, frame rate and audio, and a clip too long
  to fit at usable quality stops before upload with a message to trim it.
- A fal request that fal rejects when its result is read is recorded as
  failed, so its estimate no longer counts as spend.
- On Node 22, provider requests no longer fail at random with "Cannot
  construct a Request with a Request object that has already been used" when
  garbage collection runs during the usage price lookup.

## [0.4.3] - 2026-11-07

### Added

- Generation inputs can be selected, reordered and edited as named slots in
  the notebook inspector and chat review, with per-input controls, thumbnail
  previews and prompts that keep their references when cells move.

- `cancel_job` can cancel a leftover provider task by artifact and expected task
  ID after local jobs finish, preserving media and recording the cancellation.

- Portable `export-book` and `import-book` CLI commands preserve book identity,
  media versions, notebooks, revision history, and posting records in a
  checksummed archive. They coordinate with a running local app; imports reject
  existing names/IDs and start automatic schedules paused. Upload archives
  manually and explicitly resume schedules with `set_book_automation`.

- WaveSpeed is a new video provider with 23 models: Seedance 2.5 (text,
  image, references and video edit), Seedance 2.0, MiniMax H3 (text, image,
  references and edit), Wan 3.0 (text, image, references and video edit),
  HappyHorse 1.1, Gemini Omni 1.1 Flash (text, image and video edit),
  FLUX 3, HeyGen Video and Grok Imagine Video 1.5. Each WaveSpeed endpoint is
  its own catalog model, named with a "(WaveSpeed)" suffix, and estimates use
  the @apicity/cost WaveSpeed list prices. A submission becomes a
  `wavespeed_media` provider task that the reconcile poll completes from the
  prediction's output URL. `WAVESPEED_API_KEY` is a managed key; without it,
  generation stops before an asset is created and WaveSpeed predictions stay
  unpolled. Usage rows, provider task status and the task panel include
  WaveSpeed.

### Changed

- Every @apicity package moves to 0.27.1. Usage and price forecasts use the
  shared cost APIs, including provider-reported charges, fal billable units
  and cached realtime audio, image and text tokens. Retired fal Sora 2 models
  are removed.
- `videobook-engine` 5.9.1 preserves the existing schema and fixes portable
  book snapshots on Windows.

### Fixed

- Windows book exports no longer fail with "output file is in use by another
  connection" when creating the catalog snapshot.
- The installed web UI loads when its installation path contains a hidden
  directory.
- Recovery safely rebuilds video derivatives, and generation input dialogs
  preserve the selected notebook cells and the inspector's model choice.

## [0.4.2] - 2026-11-01

### Added

- `/split @a1 at scenes` reviews detected camera cuts one at a time, with
  large before and after frames, three frames on each side to move the cut
  to, the usual nudges and a ±1s loop across the cut. K keeps a cut, X
  removes it, J goes back and ← → nudge by a frame. A filmstrip marks each
  cut's status and adds a cut on double-click, removed cuts can be restored,
  and weaker candidates can be added for review in one step.
- `split_video_at_scenes` splits a notebook video into one clip per scene: it
  detects camera cuts, reusing a cached `detect_scenes` result, then adds a
  split cell and one output cell per scene below the source and runs it.
  Pass `cut_points_seconds` to split at reviewed times instead.
- The Kie Grok Imagine Video 1.5 preview takes a loop image (`@loop`) and up
  to four timed keyframes (`@keyframe1`-`@keyframe4`) in notebooks and
  `generate_video`. Keyframes without a time are spaced evenly over the clip.
- MachGen MiniMax H3 Omni turns image or video references into a 768p clip
  of 1-15 seconds at 0.02 USD/s. `generate_video` accepts it, and like
  MachGen's own app the model picker leaves it out.

### Changed

- `detect_scenes` places camera cuts on the exact frame and scores each
  frame's change against the surrounding half second, so hard cuts in dark
  or low-contrast footage are no longer dropped. The default minimum score
  is 5, and `detail: "full"` also returns every cut, motion settle and a
  filmstrip.
- The split editor has a cut editor under the source player: large before
  and after frames, an eight-frame strip where clicking a frame moves the
  cut, and nudges of one frame, 0.1s and 1s. Its Across cut loop replaces
  Surroundings.
- `@apicity` 0.24.0. MachGen image edits take up to 16 images for GPT Image
  2, GPT Image 2.5 Sunburst and Flare, and up to 14 for Nano Banana 2 and
  2.1, up from nine.
- MachGen MiniMax H3 Turbo estimates follow MachGen's current 0.015 USD/s
  promotion.

### Fixed

- A Grok Imagine Image 2.0 generation with connected images that fails before
  reaching xAI is captured under `v1.images.edits`, the endpoint it would have
  posted to, instead of `v1.images.generations`, so `apicity har report`
  resolves it.
- Notebook generation previews for Grok Imagine Image 2.0 name the xAI image
  endpoint, `v1.images.edits` with connected images and
  `v1.images.generations` without, instead of the video endpoint.

## [0.4.1] - 2026-11-01

### Added

- Optional Omkar trending source for research schedules when `OMKAR_API_KEY`
  is set, through `@apicity/omkar`. Status reports omkar as not configured
  when the key is unset. The default Thailand schedule makes one trending
  request per sample and does not retry it.
- `@apicity` 0.23.1, including the ElevenLabs `scribe_v2` cost rate.
  MachGen Seedance 2.5 and 2.0 estimates follow that package's public pricebook.
- Every fal video endpoint in Apicity, including Seedance 2.0 and 2.5, the
  MiniMax H3 family (LoRA, extend, 3D, lip-sync, camera controls and Max
  Turbo reference-to-video), Kling O3 Pro and v3, FLUX 3, Wan 2.7, Gemini
  Omni Flash, LTX 2.5, Luma Ray 3.2, HappyHorse 1.0 and 1.1, Grok Imagine 1.5,
  Cosmos 3, Sora 2, Veo 3.1 and HeyGen video tools. fal also adds Krea 3
  text-to-image and edit, Mirelo video-to-audio and Topaz image upscale.
- xAI Grok Imagine Video 1.5 with first and last frames, Grok Imagine Video
  1.5 Lite, and Grok Imagine Image 2.0 for text-to-image and edits.
- MachGen GPT Image 2, GPT Image 2.5 Sunburst and Flare, and Nano Banana 2
  and 2.1 for text-to-image and edits of up to nine images; MiniMax H3
  Sharpen for MachGen's own H3 videos; and reference-video edit and extend
  on MachGen models that support them.
- Extend video and Upscale video actions on video cells. Upscale uses
  MachGen's 2K regeneration for MachGen MiniMax H3 videos and otherwise the
  first configured Topaz upscaler from MachGen, fal or Kie.
- Live splice preview in the splice inspector and the chat splice review: it
  plays the first clip into the second at the predicted cut, and a
  frame-match curve sets the overlap, with a best-match jump and a quality
  grade. The read-only `preview_splice` tool scores the cuts, and
  `splice_video` cuts where the preview shows.
- `change_video_speed` retimes a section with `start_seconds` and
  `end_seconds`, and its review sheet edits the range, speed and target
  duration in place with a live preview.

### Changed

- ElevenLabs `scribe_v2` speech-to-text usage is estimated from the audio
  duration already known to the transcribe, caption, sync, render, archive,
  extend and sound-removal paths. A request with no duration stays unpriced.
- `trending_research` without arguments creates or addresses the Thailand
  schedule (Asia/Bangkok, 00:30 cutoff, four samples, top 10), and
  `/trending schedule` and `/trending TH` both work.
- The Post inspector shows a live preview, Clip, Caption, Deliver, Link and
  Results progress, a platform picker, a caption counter against the
  platform limit and a delivery rail for iPhone, download and X.
- Save to iPhone has a compact caption and an animated iCloud upload status,
  including progress a sync relay reports for servers without iCloud Drive.
- The composer's voice control is a phone button that rings while a call
  connects and hangs up on hover; the text button ends a call and returns to
  typing, and send sits beside the chat model menu.
- Notebook cells show tags naming where their wires go instead of bare port
  dots.
- Workspace action settings use a compact grid, so actions such as
  `/trending` fit on screen.
- Watermark handles default to 28px of vertical padding.

### Fixed

- Research runs that earlier builds left with stale download errors settle
  on the next scheduler tick, and their rank cells, summary and status
  recover without new downloads.
- Research archive spend stays visible after retention deletes a day book:
  archive usage moves to the control book, and `trending_research` status
  reports it.

### Security

- `@modelcontextprotocol/node` 2.1.2 and `@hono/node-server` 2.1.5.
  `hono` is no longer a direct server dependency; the SDK depends on it.

## [0.4.0] - 2026-10-28

### Added

- Daily TikTok research books with ranked clips, source provenance and a
  download-status summary. Country schedules support local cutoffs, sampling,
  ranking, retention and optional downstream processing; repeated cuts reuse
  the same day book, and schedules resume and catch up after a restart.
- `trending_research` MCP tool with `schedule`, `unschedule`, `list`, `run`
  and `status` operations, also available through `videobook run` for cron.
- Endless public trends and TikTok Creative Center adapters through Apicity,
  with normalized sightings, source health and promoted-content filtering.

### Fixed

- TikTok downloads use yt-dlp browser impersonation when available, optional
  cookies, pacing and retries, with failure reasons retained on research cells.
- Research rank cells and the summary now follow download completion and retry
  recovery, clearing stale errors after a successful download.

## [0.3.3] - 2026-10-27

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
- Subtitles can replace the video in place instead of adding a new cell:
  choose Replace video beside the subtitle editor's export buttons. Render
  burns the subtitles into the source video, keeps its earlier version in
  history, and the cell shows RENDERING until the job finishes.
  `caption_video` render takes `output: "new" | "replace"`.
- `/post` posts a clip in one step. One sheet offers three destinations:
  iCloud · iPhone, Download (the clip and caption.txt download to this
  computer for a manual upload) and X, now or scheduled. Applying a
  destination creates the Post when needed, freezes the clip and caption and
  delivers them. A clip's menu offers Post…, and a Post's menu offers Save to
  iPhone and Download.
- `/files` serves an artifact file as an attachment when given
  `?download=<name>`, so download links save instead of playing inline.
- Eighteen more MachGen video models. The picker offers LTX 2.3 Pro,
  MiniMax H3 Turbo, Seedance 2.0 Fast and Mini, Kling 3.0 and Kling 3.0 Omni,
  Veo 3.1 and Veo 3.1 Fast, Pixverse V6 and C1, HappyHorse 1.0 and Grok
  Imagine Video. Wan 2.2 A14B, Vidu Q3, Q3 Turbo, Q3 Pro, Q3 Pro Fast and Q4
  Preview, which MachGen hides from its own picker or keeps private, are
  available through `generate_video` and `list_generation_models` with
  `include_hidden`. Each model offers the resolutions, lengths, aspect ratios,
  frames and references MachGen accepts for it and is priced from MachGen's
  pricebook. Kling 3.0 Omni takes multi-shot settings: `shot_type:
  "intelligence"` lets the model plan the shots, and `"customize"` takes
  `multi_prompt` and `shot_durations`, which must add up to the duration.
- MiniMax H3 2K regeneration (`machgen:MiniMax-H3/upscale`, available through
  `generate_video`): connect a 5-15 second MiniMax H3 768p video that MachGen
  generated, and MachGen renders it again at 1440p from its original prompt
  and inputs. It costs $0.05 per second of the source, counted twice (in and
  out). Other videos and URLs are refused before anything is spent.

### Changed

- The posting MCP tools shrink from 15 to 8. `post` takes `to: icloud |
  download | x | draft` with `asset_id` for a new Post or `post_cell_id` for
  an existing one. `list_posts` reads one Post with `post_cell_id` and the
  X posts waiting to publish with `status: "scheduled"`. `update_post` takes
  `url` and `posted_at` after posting by hand, and `cancel_schedule` to turn a
  scheduled X post back into a draft. `record_post_metrics` without values
  fetches the current X metrics. `service_status` with `service: "icloud"`,
  `book_id` and `post_cell_id` reports whether a Post's files finished
  uploading.
- The Actions form and a timeline track's add-clip chooser are no longer
  modal dialogs. Both open as a review docked in the chat composer, like a
  generation review: Apply, or Enter on `/apply`, runs the action or adds the
  chosen clip, and Cancel, Escape or `/cancel` closes it. An action that needs
  confirmation shows its review and estimated cost on the first Apply and runs
  on the second; read results and their links stay on the review. In the
  fullscreen timeline editor the add-clip review docks at the editor's foot.
- Image models default to 2K again (or the highest resolution they offer
  below 2K) instead of their highest resolution; 4K stays available to
  choose. New goals plan their scene at 2K. Video models keep their highest
  resolution, and a resolution a notebook remembers from a cell still applies.
- Render in the subtitle editor no longer waits for the video: it queues the
  render, closes the editor and frees the chat, and the chat turn follows the
  job until the subtitled copy or the updated video is ready. `caption_video`
  render also returns the job's `job_id`, `status` and `output_artifact_id`
  at the top level.
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
  subtitles, SRT exports, the transcript card, search text, suggestions and
  translations now join the letters into dictionary words without spaces
  between them, Thai syllables the dictionary does not know (loanwords,
  colloquial particles such as เหรอ) stay whole, and a space in Thai ends a
  subtitle phrase so it is never silently dropped. Subtitle phrases are
  measured by visible width (Thai vowel and tone marks take none, CJK
  characters take two), the seven-word cap applies only to spaced scripts,
  and a clause too long for one phrase splits into the fewest even phrases.
  The Impact and Highlight render styles no longer put gaps between Thai or
  CJK words. Short Thai and Chinese speech now counts as dialog, so it is
  transcribed automatically. Translations from Thai send whole clauses to the
  translator, and translations into these languages time real words instead
  of character pairs. Subtitle drafts saved by earlier versions are
  discarded, and caption vocal timing is measured again once per video.

- `/alive` opens the new subtitle editor. Saved Alive caption settings seed
  the editor's style, a matching saved Alive analysis is reused instead of
  being paid for again, stored renders that still use the `alive` subtitle
  style render through the new captions, and queued `analyze_alive_captions`
  jobs run caption preparation.
- `render_video` and `render_project` no longer accept `highlight_style:
  "alive"`; use `caption_video` for word-timed subtitles.

### Removed

- The `create_post`, `get_post`, `link_post`, `save_post_to_icloud`,
  `post_icloud_sync_status`, `refresh_post_metrics` and
  `upload_post_to_dropbox` MCP tools and their slash commands. Use `post`,
  `list_posts`, `update_post`, `record_post_metrics` and `service_status`
  instead.
- Dropbox delivery: the Dropbox connection in `connect_service` and
  `service_status`, its Settings card and the `@apicity/dropbox` dependency.
  It needed a Dropbox app that was never configured, and Download covers
  manual uploads.
- The `alive_captions` and `set_alive_captions` MCP tools and the
  full-screen Alive captions studio. Use `caption_video` and the subtitle
  editor instead.

### Fixed

- A Post delivery that finishes no longer overwrites a destination chosen
  while it was still running.
- Settings shows the selected project's storage after switching projects
  while a storage check for the previous project is still loading.
- Trimming an audio asset updates its recorded duration, streams and
  waveform, so the library and timeline report the trimmed length.

### Security

- Dependencies move to patched releases: the MCP TypeScript SDK server and
  client 2.4.0, vite 7.3.7, vitest 4.1.12, zod 4.6.7 (also inside Remotion
  Studio, through an override), undici 7.30.1, hono 4.13.14, body-parser
  2.4.0, follow-redirects 1.16.2, fast-uri 3.1.9 and ip-address 10.7.5.
  `npm audit` reports no vulnerabilities.

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
