# Videobook

Videobook is a local-first notebook studio for generative media. Images, videos,
prompts, characters, and scenes are first-class cells in an executable graph,
while every book mutation is recorded as an immutable DoltLite revision.

The coordinated application requirements for the searchable audio-notebook MVP
are in [docs/mvp-prd.md](docs/mvp-prd.md).

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
pickers, a typed cell canvas, a music video editor, an asset library, jobs, history,
storage health, and provider settings.

Assets carry editable tags across three automatic facets — people, places and
editing — plus free-form custom tags, with exact filtering in the Library and
over MCP. See [docs/asset-tags.md](docs/asset-tags.md).

## Video goals

Enter `/goal @a1 @a2 as Mr Bean in Thailand`, mentioning 1–8 character
image cells. Adjacent mentions such as `@a1@a2` work. The goal tile saves the
brief, character references, plan, revision, and estimates.

The defaults are **portrait 9:16, three 10-second clips, GPT Image 2.5 Sunburst
at 2K, and Seedance 2.5 at 720p with sound**. Request landscape (16:9) or square
(1:1) explicitly. Each clip can be 4–30 whole seconds; a goal supports up to
eight shots. Image model, resolution, continuity and ending-storyboard settings
sit under **Advanced** in the compact plan review.

**Cinematic** is the default: photographic live-action, natural proportions and
textures, restrained expressions and plausible motion. **IG Influencer** uses hyper-realistic,
candid iPhone footage, natural skin texture and simple light. Try
`/goal @a1 as an IG influencer, GRWM morning routine`. The review offers:

- **Content format:** GRWM (`grwm`, `get ready with me`), OOTD (`ootd`,
  `outfit of the day`), Day in the life (`day in the life`, `vlog`), Travel reel,
  Café (`cafe`, `café`, `brunch`), Gym, Skincare, Haul or Storytime.
- **Delivery:** Selfie to camera (`selfie`, `front camera`), Filmed by a friend
  (`filmed by`), Tripod or Mirror.
- **Camera:** iPhone front (`front camera`, `iphone front`) or iPhone main
  (`main camera`, `iphone main`). The default follows delivery: front for
  selfies, main otherwise.
- **Light:** Soft daylight (`soft daylight`, `natural daylight`), Golden hour,
  Warm indoor light (`warm indoor`, `indoor warm`) or Night flash (`night out`,
  `flash`).

IG Influencer defaults to Day in the life, Selfie to camera and Soft daylight.
`ig influencer`, `instagram influencer`, `influencer`, `insta reel` and
`instagram reel` select it. Matching ignores case and accepts whole words;
the first style and first option match in the brief win. Embedded names such
as `Influencerella` do not match; a standalone style word even in a quoted
label does. Option words alone do not switch away from Cinematic.
Switching style resets its options. Style and options lock after the first
frame. **Advanced → Style anchors** shows the compact wording added by the
compiler; it is separate from editable prompts.

Each paid stage needs a separate approval:

1. **Plan → Frame:** review the title, format and short shot prompts, then
   choose **Generate frame** to show the characters together.
2. **Frame → Storyboards:** inspect the frame, type a one-line change and
   **Revise**, pick a previous version, or **Regenerate** a fresh take. Repeat
   until it is right, then **Use this frame · Generate storyboards**.
3. **Storyboards → Videos:** use the same revision and version-selection loop
   for each storyboard. **Back to frame** lets you revise or regenerate the
   full frame again. Choose **Use these storyboards · Generate videos** when
   every selected still is current. Each storyboard is a four-panel 2×2 sheet
   showing setup, action, reaction and ending, read left to right, then top to
   bottom. Beneath each picture, new sheets show its time range and a brief
   action/camera note. A 10-second clip uses 0–2.5s, 2.5–5s, 5–7.5s and 7.5–10s.
   Video prompts give each beat a quarter of the clip and request full-screen
   footage without the grid, notes or text. Sound is ambience or speech; prompts explicitly request no music.
   Review the output for stray labels and continuity.
4. **Combine:** multiple clips append in order after existing sequence content,
   using actual media durations. A single clip finishes without assembly.
   **Combine into one video** renders a shareable MP4 locally with the clips'
   sound. Repeating the action reuses its output.

Every still attempt is kept as a version. Revisions start from the selected
image and preserve the earlier one. A selected still made from an older plan
prompt cannot be approved until it is regenerated, revised, or its prompt is
restored. Changing the selected full frame preserves the old storyboards but
marks them stale until they are regenerated or revised against that frame.
Editing a shot's action, duration or storyboard prompt also requires a refreshed
storyboard. Older single-frame previews stay available as versions but must be
regenerated or revised into four-panel sheets before video approval.
Format, image model and resolution, continuity, and shot count stay fixed after
the first frame; its prompt remains editable at either still review.

Goal notebooks place references, goal tiles and generators on the first row,
generated images on the second, videos on the third and the timeline on the
fourth. Groups exceeding eight cells continue on extra rows, shifting later
groups down. New goal outputs and **Arrange** use the same layout.

Prompts use barebones noun/verb fragments. The storyboard guides the video;
video prompts add only essential motion and sound. Planner word ceilings are
6 for titles, 30 for continuity, 20 for the frame, 32 for each storyboard,
12 for ending prompts and 12 for video prompts. These are ceilings, not targets.
New plans use bounded responses and one shortening retry. Saved plans retain their
larger text limits, and word counts guide edits without blocking longer text.
Only the frame repeats continuity; later requests use compact reference legends.

The primary button saves pending edits first; Cmd/Ctrl+Enter does the same.
**Ending frames** is off by default. Enable it under Advanced before the
frame to add an ending image per shot. A blank ending prompt uses the final
moment of the video prompt. Each ending image can be revised or regenerated
independently. Its clip uses the storyboard and ending image as visual
references; the ending image guides the final pose and composition.

Stage and per-image estimates label paid approvals. Every revision or fresh
generation incurs its image cost again. Planning requires `OPENAI_API_KEY`
and is billed separately; generation requires `KIE_API_KEY`. A structured
version-2 plan skips AI planning.

The chat status reports each stage and revision with a generation clock.
Progress adds STATUS rows, and notebook tiles carry provenance edges and
version marks. Click the status or goal tile to reopen its review.
**Stop goal** prevents remaining work; submitted requests may still finish and
incur cost. While a still is being revised or regenerated the button reads
**Stop revision** or **Stop regeneration** and returns to the review with the
previous version selected. Deleting the goal tile also stops it. **Retry**
resumes the failed stage without repeating completed outputs, or plans again
after a planning failure. **Dismiss** hides a finished goal.
Version-1 goals remain readable; unfinished ones ask you to start a new `/goal`.

MCP clients use `video_goal` actions `create`, `list`, `status`, `update`,
`approve`, `select`, `revise`, `regenerate`, `cancel`, `retry`, `dismiss`,
`assemble`, and `combine`. Paid approvals require the current `revision`.
`select` takes `stage`, zero-based `index` and `artifact_id`, and leaves the
plan revision unchanged. `revise` takes `stage`, `index` and 1–300 characters
of plain-text `feedback` without @ references. `regenerate` accepts `stage`
and `index` for one still, or legacy `shot_indexes` to regenerate selected
storyboard pairs. Execution state and attempt history use scoped engine settings.

The version-2 `plan` accepted by `create` and `update` can include
`"style": { "id": "ig-influencer", "options": { "format": "grwm", "delivery": "selfie-to-camera", "camera": "iphone-front", "light": "soft-daylight" } }`.
Missing options use the style defaults; unknown keys or choices are rejected.
Omitting `style` means `{"id":"cinematic","options":{}}`, including in older
stored plans. An explicit plan's style takes precedence over brief keywords.

The provider-free browser check runs with `npm run test:e2e -- tests/v2/goal-ui.e2e.test.ts`.
A separate paid check uses `VIDEOBOOK_RUN_MODEL_E2E=1 op run --env-file=.env.tpl -- npx vitest run --config vitest.goal-live.config.ts -t "IG Influencer goal with real providers"`.
Choose `Cinematic goal with real providers` for the original scenario.
It uses two portrait 4-second 480p clips, 1K images, and one revision at each
still stage. It checks version selection, prompts, portrait media and identity,
requires a media estimate below $3, and preserves its scratch book and spend records. The ordinary test setup keeps its network and
credential restrictions.
The IG test uses the checked-in NASA portrait from
[scikit-image's public-domain astronaut sample](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut)
as a face reference. Its generated GRWM sequence is synthetic test media.
Review the preserved outputs for identity, skin texture, phone-camera appearance,
four visible story beats, sound and the absence of grids or borders in video.

## Storage

Each book owns an isolated `videobook-engine` v5.6.1 schema-v27 root under
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

Install the application and server workspace from the repository root. The engine is included as a pinned vendored package; a sibling engine checkout is not required.

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
`VIDEOBOOK_ENV_PATH` selects the local environment file used by Settings;
it defaults to the repository's `.env`. This also allows isolated application fixtures.

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

## Quality gates

```bash
npm run lint
npm run test
npm run test:clean-install
npm run test:e2e
npm run build
npm run build:server
```

The clean-install gate exports the current commit into a temporary directory, runs one workspace install, builds both surfaces, and checks health, MCP book creation/listing, client delivery, a shared Sharp/libvips image round-trip, and graceful server shutdown. It uses isolated books, app state, and model cache without provider credentials or a sibling engine checkout. Use `npm run test:clean-install -- --worktree` to validate pending changes before committing; the default verifies committed source.

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
