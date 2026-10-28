# Videobook

Videobook is a local-first notebook studio for generative media. Images, videos,
prompts, characters, and scenes are first-class cells in an executable graph,
while every book mutation is recorded as an immutable DoltLite revision.

The coordinated application requirements for the searchable audio-notebook MVP
are in [docs/mvp-prd.md](docs/mvp-prd.md).

## Install and run

Videobook ships on npm as the `videobook` command (Node.js 22 or newer):

```bash
npm install -g videobook
videobook                     # MCP server and web UI at http://127.0.0.1:3001/
videobook serve --headless    # MCP and HTTP API only
videobook mcp                 # stdio MCP for agent hosts
claude mcp add videobook -- videobook mcp
```

[server/README.md](server/README.md) is the package documentation: install
scripts under npm 12, every command, the `~/.videobook` data home, provider
keys and 1Password, agent setup, and platform notes.

## Repositories

- `~/videobook` — React frontend, MCP server, providers, and job workers
- `~/videobook-engine` — public `videobook-engine` package and storage API
- `~/videocity` and `~/videocity-engine` — unchanged predecessor repositories

## Product model

A book contains one or more notebooks. A notebook is a directed graph of
typed cells:

- prompt
- character
- scene
- image
- video

Connections carry outputs into named inputs. Runs are explicit and queued, and
their cell order and resulting asset/entity references are recorded. New books
begin with a `Main` notebook.

Project names are lowercase slugs with hyphens: `My Café Project` becomes
`my-cafe-project`. Creation and rename use the same normalization in the UI,
MCP API, and engine. Existing names are converted when the library opens;
collisions receive numeric suffixes while existing slugs keep their names.
Book IDs, notebooks, and media stay attached to the same project.

The frontend is a green notebook-first workspace with book and notebook
pickers, a typed cell canvas, a music video editor, a library picker above chat, jobs, history,
storage health, and provider settings.

Assets carry editable tags across three automatic facets — people, places and
editing — plus free-form custom tags, with exact filtering in the Library and
over MCP. See [docs/asset-tags.md](docs/asset-tags.md).

## Video goals

Enter `/goal @a1 @a2 @a3 interview with a giant microphone`, mentioning a
scene screenshot and any character or prop images. The planner reads the
images and suggests each reference's role. Review those roles before generating.
Adjacent mentions such as `@a1@a2` work; a goal accepts up to eight references.

New goals default to **one 20-second portrait video**, with **Nano Banana 2.1
at 2K** for images and **Seedance 2.5 at 720p with audio and no music**.
The source screenshot sets the visual style. Choose **Cinematic** or
**IG Influencer** under **Advanced**, where format, models, resolutions,
continuity, durations and optional additional clips are also available.
Explicit requests such as `two 10s clips` still create multiple clips; scene
or storyboard beat counts alone do not split the video.

The review has three stages, each with its own paid approval and estimate:

1. **Scene:** review the requested edit and generate the scene. Inspect it,
   revise it with a short instruction, regenerate it, or choose an earlier version.
2. **Storyboard:** approve the scene to generate a six-panel sheet, arranged
   in two columns and three rows. Panels run left to right, top to bottom,
   with timestamps and brief action/camera notes below the pictures.
3. **Video:** approve the storyboard to generate one continuous video using
   the sheet, approved scene and original references. The sheet is a reference,
   never a literal first frame. Video directions add motion, dialogue and ambience.

You can revisit and revise any stage after completion. Still revisions edit
the selected image; video revisions rerun Seedance from the selected references
and updated directions. All attempts remain visible, and stopping or failing a
revision preserves the prior selection. Nothing regenerates downstream automatically.

Changing an upstream prompt, setting, selected version or source image marks
its dependent outputs stale. Refresh them before generating video. Changing
only a video's motion or sound leaves its six-panel storyboard current.
Clip count and storyboard layout stay fixed once generation begins. Saved
older goals retain their models, styles, durations and four-panel storyboards.

Goal notebooks use separate rows for **references**, **goal and generators**,
**generated images**, and **videos**. Groups exceeding eight cells continue on
additional rows. Multi-clip timelines follow the videos. New output placement
and **Arrange** use the same layout and preserve identities and connections.

Multiple clips initially append in order using their actual media durations.
After revising or selecting a different video version, **Assemble selected
versions** updates the goal's unchanged timeline clips. If those clips were
edited, assembly preserves the user's edits and asks for manual placement.
**Combine into one video** renders the selected, assembled clips locally with
their audio. Changing video selection invalidates an older combined output.

Prompts stay concise: planner ceilings are 6 words for titles, 30 for
continuity, 20 for the scene, 48 for a six-panel storyboard, and 12 for video
directions. Longer saved prompts remain editable. Planning uses `OPENAI_API_KEY`
and is billed separately; generation uses `KIE_API_KEY`. A structured version-2
plan skips AI planning. Every paid stage or revision requires an explicit action.
**Stop goal** stops remaining work; already submitted requests may still finish.

New image editing sessions also default to **Nano Banana 2.1 Edit**. Explicit
model choices and saved producer reruns keep their chosen model. Apicity 0.15.0
supplies the NB 2.1 schema and pricing; the OpenAI and xAI packages retain the
repository's realtime patches, and the X package keeps its posting patches.

Video generation also includes **Vidu Q4 image-to-video** and **Vidu Q4
reference-to-video** through KIE. Both support 3–16 seconds, 540p through 4k,
and optional generated audio. Image-to-video uses one image and inherits its
aspect ratio. Reference-to-video accepts 1–15 images and up to three MP3 audio
references, each 3–12 seconds and at most 50 MB. Cost previews use the selected
duration and resolution from Apicity's published rates.

Apicity 0.15.0 adds these fal models to the picker, shown under the names
`@apicity/cost` publishes: **Seedance 2 US** text, image and reference video;
**Kling o3 Standard** image-to-video; **Kandinsky 6.0 Pro** and **Lite** text-
and image-to-video and **Kandinsky 6.0 VSR**, which upscales about the first
five seconds of a clip; **H3 Max Relight** and the 16-bit Pixel, Hand Drawn,
Low Poly, Retro Toon 70s and VHS **H3 Max** styles; **PixVerse VibeMV** music
videos from a song; **Pixelcut Looping Video**; **Creatify Boreal**; **Mirelo
SFX 2.0** soundtracks for an existing video; **Flux 2 Flex**; **Bria Guided
Remove Background** and **Fibo Edit 1.5 Expand**; and **Marigold V2** depth,
normal and albedo maps. The fal routes for Nano Banana 2.1, Vidu Q4 and
Seedance 2.5 US stay out of the picker because KIE already serves those models
there; they, and Seedance 2.5 draft completion, remain available to
`generate_image`, `generate_video` and `list_generation_models` with
`include_hidden`. Since 0.16.0 fal Seedance estimates come from the output size,
resolution and duration. Dynamically billed fal models use fal's historical
average per call when `FAL_ADMIN_API_KEY` is set, and that estimate warns that
it ignores the request. Without that key they stay at $0 with a warning naming
the billed unit. See [docs/apicity-gaps.md](docs/apicity-gaps.md).

## Posts and results

Post a finished image or video in one step: type `/post @a1` (optionally
followed by a caption), or choose **Post…** from the clip's menu. The sheet
offers three destinations:

- **iCloud · iPhone** saves the clip and `caption.txt` to iCloud Drive ›
  Videobook, so they appear in Files on your phones.
- **Download** downloads the clip to this computer, with links to the clip and
  `caption.txt`, for a manual upload.
- **X** opens the X review to publish now or on a schedule, with optional
  thread replies.

Each Post represents one publication on X, Instagram, TikTok, YouTube or another
platform. It preserves the source clip version and upstream idea/prompt lineage
even when the original cells move or change. The first delivery freezes the
clip and caption, so post the clip again for a different caption or a repost.
After posting by hand, paste the actual post URL and publication time into the
Post. **Add cell → Post** makes an empty Post to fill in later.

Over MCP the whole flow is one `post` call with `to` set to `icloud`,
`download`, `x` or `draft`; `download` returns links served with
`Content-Disposition: attachment`. `list_posts` with `status: "scheduled"` lists
the X posts waiting to publish, and `update_post` with `cancel_schedule: true`
cancels one and returns the Post to a draft.

The **Posts** table compares publications within a book, including observations
at similar ages. X metrics are collected after publication/linking, then at 1h,
24h, 72h, 7d and 28d; **Refresh now** adds a current observation. Other platforms
accept manual observations. Missed checks record their actual observation time.
Missing values remain unknown, and X media views are labeled separately because
they may include multiple posts using the same media. Private X metrics depend
on ownership/access and expire after 30 days.

Publication receipts and metric history survive notebook undo. If an X request
has an uncertain outcome, check X and attach the existing post link. Create a
new Post only after verifying that nothing was published. Legacy X tiles migrate in place, with historical media versions marked
unknown when they cannot be established.

## Storage

Each book owns an isolated `videobook-engine` v5.7.1 schema-v28 root under
`VIDEOBOOK_LIBRARY_DIR/<book UUIDv7>/`. That root holds its embedded DoltLite
catalog, content-addressed objects, managed files, notebook graph, primary sequence,
history, and runtime tables. Media bytes can be published to B2 under immutable
keys. Per-book scheduled posts live in ignored engine runtime settings. Only
application-wide credentials, including X OAuth tokens, live separately at
`VIDEOBOOK_APP_STATE_PATH`; that file is never part of a public book record.

Remote media downloads are checked against their expected SHA-256 before entering
the local content store or an artifact workspace. Corrupt downloads return
`OBJECT_UNAVAILABLE` and leave the book intact; correcting the remote content
allows a retry. Existing local objects are not retroactively rehashed.

The global clip archive is an application-level rebuildable cache, not book
semantic state. Its search indexes and topic/person markers are derived from
immutable media, transcript, and ingest objects. When a book asset is archived,
the catalog keeps the canonical archive link and user-visible archive metadata
on that artifact; deleting or rebuilding the external archive cache does not
change the book's revision history.

Rewind is forward-only: Videobook materializes the selected historical state,
then creates a new revision. It never checks out detached history, rewrites
history, or deletes canonical B2 objects.

The engine materializes scratch paths within each book root for ffmpeg and
Remotion. `/files/:bookId/:artifactId/*` resolves managed content through the
selected book engine; file paths are not an authoritative data model.

## Development

Requirements:

- Node.js 22 or newer
- ffmpeg
- 1Password CLI only when loading cloud-provider credentials from `.env.tpl`

Install the application and server workspace from the repository root. The engine is pinned to an exact `videobook-engine` release on npm; a sibling engine checkout is not required.

```bash
cd ~/videobook
npm ci
```

Run locally without cloud-provider credentials:

```bash
npm run dev:local
```

Run with credentials loaded through 1Password:

```bash
npm run dev
```

The frontend is served on port 5173 and the MCP server on port 3001.

The same CLI the package ships runs from a checkout. A checkout keeps its data
in the repository (`books/`, `runtime/app-state.json`, `.env`) instead of
`~/.videobook`, unless `VIDEOBOOK_HOME` or `--home` says otherwise:

```bash
npx tsx server/src/cli/entry.ts serve --headless
npx tsx server/src/cli/entry.ts doctor
npm run build:package && node server/bin/videobook.js serve   # with the built UI
```

`npm run use <tool> key=value` runs one tool through the same CLI with
credentials from 1Password.

The HTTP server binds to `127.0.0.1`. Every route, including MCP, uploads,
media files, manifests, and archive files, checks the request Host and Origin
before reading a body or accessing data. Only loopback hosts (`localhost`,
`127.0.0.1`, `[::1]`) are accepted. Browser origins may use HTTP or HTTPS on
those hosts at any local port, supporting Vite and preview servers. Foreign,
opaque (`null`), and malformed origins are rejected with HTTP 403. CORS echoes
only an accepted origin. Native clients without an Origin remain supported;
browser requests marked cross-site without an Origin are rejected as well.

The bundled Chrome extension is allowed by its exact stable origin,
`chrome-extension://cebmihgcglhadjckbebmfahaiiljhgdj`. Run
`npm run build:extension` and load `dist-extension` as an unpacked extension
in `chrome://extensions`. Existing unpacked installations must be reloaded
from that build and show this ID. The manifest public key fixes the development
ID; it is not a credential or authentication token. Other extension origins
are rejected.

This is a local single-user service: local processes and accepted local browser
origins can access all books. The request policy is not user authentication,
and book IDs and object hashes are not credentials. Remote or shared hosting
is not supported by this local policy; an authenticated deployment requires a
separate access design. Artifact file and manifest routes resolve only within
the supplied owning book, including range requests.

Media and archive responses also enforce a sandboxed Content Security Policy
and disable MIME sniffing. SVG/HTML source files can render static content but
cannot execute scripts, submit forms, access the local API, or load resources
from external origins. Images and media may use local or embedded data sources;
inline styles remain supported. This protects the trusted local origin when
an imported file is opened directly in a browser.

### Local push checks

Enable the repository's Git hooks once per clone after installing dependencies:

```bash
git config core.hooksPath .githooks
```

The pre-push hook runs `npm run check:dead-code` when the pushed changes include
TypeScript files (`.ts`, `.tsx`, `.mts`, or `.cts`). A failed check blocks the
push. Documentation-only pushes and ref deletions skip it. New refs, or refs
whose remote commit is unavailable locally, are checked against an empty tree.
The check uses the current working tree, so push from the checkout containing
the changes you intend to deliver. It runs locally without the full test suite;
CI still runs its existing Knip check.

### Coding agents

Shared project rules live in [AGENTS.md](AGENTS.md). Claude Code supports it
natively from v2.1.277; use v2.1.281 or later for the early provider and telemetry
support fixes. See [Anthropic's AGENTS.md documentation](https://code.claude.com/docs/en/memory#agentsmd).

With the default Project instructions setting (`claude-md-or-agents-md`),
Claude reads `AGENTS.md` when no `CLAUDE.md`, `.claude/CLAUDE.md`, or
`CLAUDE.local.md` exists in the working directory or its ancestors. Personal
`~/.claude/CLAUDE.md` and managed instructions continue loading alongside it.
If you keep an ancestor or local instruction file, use `/config` to select
`claude-md-and-agents-md`. This is a user setting; project settings cannot
override it.

Check for the `AGENTS.md loaded` startup message. If the built-in AGENTS.md
plugin is disabled, enable it through `/plugin` and start a new session.
After upgrading from v2.1.276 or earlier, a second session may be needed.
Keep project instructions in `AGENTS.md` and persistent project memory in
Beads (`bd remember`).

## Environment

The storage-specific variables are:

```text
VIDEOBOOK_LIBRARY_DIR
VIDEOBOOK_APP_STATE_PATH
VIDEOBOOK_OBJECT_PREFIX
VIDEOBOOK_CATALOG_BACKUP_URL_TEMPLATE
B2_ACCESS_KEY_ID
B2_SECRET_ACCESS_KEY
B2_REGION
B2_BUCKET
B2_ENDPOINT
```

Provider credentials continue to use the existing `@apicity` integrations.
See `.env.tpl` for the complete set.
`VIDEOBOOK_ENV_PATH` selects the local environment file used by Settings.
In a source checkout it defaults to the repository's `.env`, books default to
`books/`, and application state to `runtime/app-state.json`. An installed
package keeps all three in `~/.videobook` instead; `VIDEOBOOK_HOME` moves that
data home. Set `VIDEOBOOK_HOME` and `VIDEOBOOK_ENV_PATH` in the shell, because
they choose which `.env` is read. These also allow isolated application fixtures.
Outside `op run`, values that are `op://` references and the vault named by
`VIDEOBOOK_OP_VAULT` resolve through the 1Password CLI when a server starts;
`VIDEOBOOK_OP_SERVICE_TOKEN` names the service-account token, for example
`env:OP_SERVICE_ACCOUNT_TOKEN`.
`VIDEOBOOK_FFMPEG_PATH`, `VIDEOBOOK_FFPROBE_PATH` and `VIDEOBOOK_YTDLP_PATH`
override the bundled media binaries; without them the server falls back to
`ffmpeg`, `ffprobe` and `yt-dlp` on PATH when a bundled binary is missing or
built for another CPU.

### Voice chat

The microphone beside Send enables voice input and spoken replies. Voice starts off.
Click once to allow microphone access and open the COMMS panel; click Stop to release
the microphone and audio immediately. Each start greets the speaker with a spoken
"Voice Chat Activated" line. The ring follows actual sound levels, and
expandable captions keep the conversation visible while you type. Speak over a reply
to interrupt it. Reviewed actions still require Apply or Cancel on screen, including
generation that can incur provider spend. Turning voice off preserves a pending review
and your typed draft.

Voice requires `OPENAI_API_KEY`, microphone permission, and WebRTC/Web Audio support
on HTTPS or localhost. The default is `gpt-realtime-2.1`, selected by a local comparison
with `gpt-realtime-2.1-mini`. Set `VIDEOBOOK_VOICE_MODEL` on the server to select another
compatible Realtime model; the text chat model selector is independent. Idle sessions
end after 120 seconds (`VIDEOBOOK_VOICE_IDLE_TIMEOUT_MS`, bounded to 10–600 seconds).
Sessions also end after 30 minutes, with at most four active sessions per server.

Voice stops when you leave its project/notebook, hide the page or composer, open a
fullscreen preview, start other media playback, lose capture, or disconnect. Restart
explicitly after returning. If playback is blocked, use **Enable spoken replies**.
Permission and configuration errors appear in COMMS with recovery instructions.
Videobook saves finalized transcripts through the book engine; it does not save raw
microphone audio. Audio is sent to OpenAI for the live conversation. Existing
ElevenLabs `/speak` media generation keeps its separate preview workflow.

See [voice transport and validation](docs/voice-chat.md) for configuration, measured
latency, provider provenance, and the opt-in live browser checks.

### Local search models

Search and indexing use cached CLIP/CLAP models by default. They do not download missing models. To check readiness without downloading, run:

```bash
npm run prepare:search-models
```

To explicitly download and prepare the pinned models from Hugging Face:

```bash
npm run prepare:search-models -- --download --models all
```

Use `--models visual` for image/video search or `--models audio` for audio search. The command operates only on the model cache and exits unsuccessfully if a model cannot be prepared. Interrupting the command stops its process; rerun it to reuse completed cache files.

The cache defaults to `~/.cache/videobook/models`; `VIDEOBOOK_MODEL_CACHE_DIR` selects another location. Ordinary operations remain offline after preparation. Administrators who want the server to download missing pinned models during search/indexing can explicitly set `VIDEOBOOK_MODEL_DOWNLOAD=enabled`; unset, `disabled`, and unrecognized values keep downloads disabled. The preparation command requires `--download` even when that server setting is enabled.

The bundled engine requires a full `modelRevision` commit SHA for custom remote models in its compatibility similarity API. Older compatibility image/video caches require reindexing. The application uses temporal search, whose model and index identities are unchanged by this migration.

Built-in providers declare local inference; the server grants model-download permission only from the explicit setting above. Injected providers must declare network capabilities and receive separate application consent.

Pinned model files are checked before inference, including files already cached. Corrupted files fail with `MODEL_UNAVAILABLE`; they are not treated as missing offline models or silently accepted. Failed indexing and reference jobs preserve the source media. Replace the damaged cache files with verified model files before retrying.

When models are missing, reverse-search errors include the preparation command. Missing-model semantic indexing stays deferred while preserving the original media and existing coverage. Decoder failures, timeouts and model resource failures fail the auxiliary indexing job while leaving the media itself ready; retry that job after addressing the cause. Cancelling indexing or reference preparation stops active model work. Failed or cancelled reference preparation also preserves the source media's status. Audio-only sources use the audio model without invoking the image decoder.

After preparation, retry the search and reindex affected media to populate semantic coverage; preparing models alone does not index the library.

Search, index jobs, ingest status, and reverse-reference preparation use local media only, even when remote storage is configured. Missing media fails an auxiliary indexing/reference job with `MEDIA_MISSING` and retrieval instructions; the source asset remains ready. Retrieve the file explicitly before retrying. Library browsing does not download absent files to generate previews. History restores commit the requested metadata and defer unavailable media hydration. Explicit file retrieval, copying, and backup retain their normal storage behavior.

## Runtime diagnostics

`VIDEOBOOK_LOG_LEVEL` selects `silent`, `error`, `warn`, `info` (default), or
`debug`. All levels use the same privacy policy. Server console logs and
persistent job diagnostics contain fixed event names, validated UUIDs and queue
IDs, counts, durations, and allowlisted error codes. Tool and job names are
accepted only after registration by the application. Unknown error codes become
`UNKNOWN`; messages, stacks, prompts, transcripts, book names, paths, model
labels, URLs, and provider response bodies are excluded. Cost diagnostics retain
availability, reason, warning count, and validated correlation fields.

The shared boundary is [server/src/diagnostics.ts](server/src/diagnostics.ts).
Runtime callers use `logger` for console events and `appendDiagnostic` for
persistent events. Register diagnostic operation names only from trusted tool
and job definitions, never from request values. ACE-Step stdout/stderr and
unused FFmpeg waveform stderr are drained without being copied into diagnostics.
To inspect ACE-Step output directly, run the configured server explicitly.

Detailed errors remain in MCP/CLI responses and job/artifact failure state.
Explicit chat history retains the messages the user asked to save. This policy
applies to newly written diagnostics; existing log files are not rewritten.

### Opt-in provider captures

Provider HAR capture is off by default. Enable it in Settings → Diagnostics, with
`videobook config set har_capture failures` (or `all`), or through
`set_har_capture`. Use `off` to disable it. Changes apply to the next call without
restarting. `VIDEOBOOK_HAR_CAPTURE=off|failures|all` overrides the saved mode;
an invalid override disables capture. `videobook doctor` reports mode, directory
and writability.

When enabled, captures retain prompts, media URLs, model parameters, provider
responses and error text locally. Known secrets and cookies are scrubbed; binary
media and bodies above the 256 KiB cap become placeholders. Review captures
before sharing: arbitrary private text is not anonymized. Realtime WebSockets
and output media downloads are not captured. The default logging policy remains
unchanged when capture is off.

Captures live in `runtime/har` in a source checkout, or `<VIDEOBOOK_HOME>/har`
(default `~/.videobook/har`) when installed, with an `index.jsonl`. The application
state `harCapture` block stores `mode`, `maxAgeDays` (default 30), and
`maxTotalMB` (default 512 MiB). The settings tool can change the limits. Startup
and daily queue sweeps remove the oldest captures over these limits. Sweeps do
not run while capture is off.

`VIDEOBOOK_OP_VAULT` fills any empty environment variable named after a vault
item. Never create a vault item named `VIDEOBOOK_HAR_CAPTURE` unless capture is
intended; a vault value can enable it on startup.

Each capture is one apicity call. SDK calls are named by their apicity catalog
dot path (`api.v1.jobs.createTask`), so `apicity har report` attributes them to
the right endpoint. Generation submissions, completions and uploads are also
recorded under Videobook's own names (`generation.submit`), which apicity reports
as unresolved calls.

### Sharing captures with apicity

Captures let apicity correct its schemas and defaults from real working and
failing payloads. To debug one generation attempt, open its queued, generating
or failed cell: the Request payload panel offers **HAR** when the attempt has a
capture and downloads all of the attempt's captured calls as one scrubbed HAR
file, one page per call. When capture is off it shows **Capture off**, which
opens Settings. Over MCP, `inspect_generation_request` reports `har.mode`,
`har.hasCapture`, `har.path` and `har.outcome` for an asset, and
`get_generation_har` returns the HAR for an asset id or attempt id. Captures
match an attempt by its asset or attempt id, then by its provider task id.

To share a corpus, export it:

```bash
videobook har list --failures      # newest first; also --since, --provider, --json
videobook har export --out ~/videobook-har.tar.gz --since 2026-10-01 --failures
videobook har export --out ./captures --provider kie,fal
```

`har export` reads the capture index, re-runs `scrubHar` from `@apicity/har` on
every selected file and refuses, naming each file, if scrubbing would change
anything. That means apicity lacks a scrub rule: report it to apicity instead of
editing the capture. Otherwise it writes the captures in their original layout
with an `index.jsonl` and a `manifest.json` (calls per provider, endpoint and
outcome, the date range, and the Videobook and apicity versions) to a new
directory or `.tar.gz`, and prints the hand-off for a maintainer:
`apicity har report <dir>` for the learning report, and `apicity har scrub
--check` followed by `pnpm run har:promote` in the apicity repository to turn a
successful call into a replay test.

The export contains what capture kept: prompts, media URLs, model parameters,
provider responses and error text. Prompts and media URLs are included because
turning capture on is the consent to keep them; API keys, cookies and media
bytes above the cap are not. Read the files, then send the directory or archive
privately to an apicity maintainer, for example by email or a private file
share, never in a public issue. Videobook uploads nothing on its own.

## Quality gates

```bash
npm run lint
npm run test
npm run test:pack-install
npm run test:e2e
npm run build
npm run build:server
```

The pack-and-install gate exports the current commit into a temporary directory, runs `npm ci`, checks that the engine comes from npm, builds and packs the `videobook` package, and checks the tarball's size and contents. It then installs the tarball globally into a temporary prefix and checks that every dependency with an install script is on the documented `--allow-scripts` list, that one Sharp copy loads, and that `videobook --version` and `videobook doctor` pass. It prints the installed footprint and the largest packages. It runs `videobook serve --headless` (health, MCP book creation/listing, the library lock, graceful shutdown), `videobook serve` (web UI shell, assets, deep links), and `videobook mcp` over stdio. Finally it repeats the install with install scripts skipped and expects `doctor` to name the `--allow-scripts` remedy, the bundled ffprobe to run, and yt-dlp to resolve from `PATH` or `VIDEOBOOK_YTDLP_PATH`. It uses an isolated data home and caches without provider credentials. `npm run test:pack-install -- --worktree` validates pending changes; `--npm12` also checks npm 12's strict install-script policy; `--artifact-dir <dir>` keeps the tested tarball. `npm run test:clean-install` is an alias.

Releases publish from a machine signed in to the 1Password CLI, with the same
npm credential Apicity and the engine use, `op://apicity/NPM_TOKEN/password`.
Set the version in `server/package.json`, rename the changelog's Unreleased
section to that version, and commit on `main`. Then:

```bash
npm run release -- 0.1.0 --dry-run   # every gate, then npm publish --dry-run
npm run release -- 0.1.0             # publish the tested tarball, verify it, tag locally
npm run release -- 0.1.0 --push      # push main and the tag, create the GitHub release
```

The release script runs lint, the dead-code check, the type checks, the full
suite, and the pack-and-install gate, then publishes exactly the tarball that
gate tested. It reads the token into a temporary npmrc and deletes it
afterwards; the token never goes into `.env` or GitHub. After publishing it
checks the registry's integrity against the tested tarball and installs the
release back from npm. The Release check workflow reruns the gates and the npm
12 smoke for every pushed `v*` tag.

Releases carry no npm provenance attestation. npm creates one only for a
package published from a CI provider through trusted publishing, and these
releases publish locally while the source repository is private. For the same
reason the npm package lists no repository or issue tracker links.

For the engine:

```bash
cd ~/videobook-engine
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Detailed inherited MCP command documentation remains in
`docs/command-reference.md`.

Extract a sanitized, metadata-only Videocity development corpus with:

```bash
npm run extract:videocity-benchmark -- \
  --source-root ~/videocity \
  --project multiculty \
  --output /path/to/new-output-directory
```

The extractor copies no media and marks unreviewed rights and relevance data as
ineligible for the release benchmark.
