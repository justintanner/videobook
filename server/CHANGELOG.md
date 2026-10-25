# Changelog

All notable changes to the `videobook` npm package are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- HAR captures of KIE's nested Veo and Suno SDK calls are named by their
  apicity catalog dot paths, such as `api.v1.veo.generate` and
  `api.v1.generate.sounds`, instead of their SDK paths, so `apicity har report`
  resolves them. Sub-provider prefixes that are URL segments stay:
  `kie.claude.post.v1.messages` is named `claude.v1.messages`.

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
