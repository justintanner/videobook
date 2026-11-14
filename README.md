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

`/goal` makes a short: a real-looking phone video of 5 to 60 seconds that
stars the person in the images the brief mentions, or the person the brief
describes when it mentions none. That person never speaks.

**Source images.** Every image the brief mentions is a source image, used as
it is: the frame keeps each person exactly as photographed (face, hair, build
and clothes) and whatever else the brief takes from the picture. The first 12
usable images are kept. A brief with no image plans the person from its own
words; there is no main character to set up and no character sheet to make.

**Storyboard.** The first video the brief mentions becomes the short's
storyboard. Its frames are captured into image cells when the goal is
created, at no cost: one per shot when the video has cuts, otherwise the
middle of each quarter, 4 by default and fewer for a very short video,
starting at a time such as `@a1 at 3s` when you give one. A further video is
skipped with a note, and the note names the storyboard frames' cells and
times. The planner reads the source images and then the storyboard frames in
order, follows the storyboard's action, camera and order with the brief's
changes, and never describes what is drawn on top of the picture. For
example, `/goal make a 12s viral TikTok clip based on @a1 but with @a2 holding
the umbrella for a monitor lizard, realistic` follows the video in @a1 with
the man from the photo in @a2 and a monitor lizard in place of the video's
animal.

**Starting a short.** Enter an idea such as `/goal he waits for a bus in the
rain`; no @mention is needed. Name a length such as `20 seconds` (5 to 60, 12
by default), or ask for `square` or `landscape` (portrait 9:16 by default).
Empty cells, audio, pending outputs and unreadable media are skipped, and
notes above the plan name each skipped mention and the storyboard.

Lengths outside 5–60 seconds are clamped to that range. Extra quoted beats get
segments where they fit, or are folded into the last beat. The planner writes
the title, the frame prompt and one beat per clip. Quote them as `frame: "…"`
and `beat 1: "…"` to write them yourself and skip planning. Without an OpenAI
key, the brief itself supplies a reviewable plan, with a note explaining how
to enable the planner.

**Review.** The goal panel has a tab per stage, and every paid step has its
own approval with its estimate:

1. **Storyboard** (only for a short made from a video): the video's frames in
   order with their times, each before and after its clean-up. **Remove
   on-screen graphics** runs one Nano Banana 2.1 edit per frame that removes
   what was drawn on top of the picture: captions, titles, stickers, emoji,
   platform logos and watermarks, creator credits with their icons, progress
   bars, borders, black or blurred bars and shade gradients. Printing that is
   physically in the scene, such as a logo on an umbrella, stays. Regenerate a
   frame, revise its clean-up with a short instruction, or choose an earlier
   version. When one frame's clean-up fails, for example because the model
   refuses it, the other frames are still cleaned. The failed frame shows its
   error and can be regenerated or revised on its own, and the goal stays on
   this tab until every frame is clean.
2. **Frame:** the opening still, made with GPT Image 2.6 from the source
   images and, for a short made from a video, clean storyboard frame 1. That
   frame gives the camera angle, framing, pose and action; the people and
   animals come from the source images and the brief. **Generate frame** stays
   disabled until the whole storyboard is clean. Regenerate the frame, revise
   it with a short instruction, or choose an earlier version. A new version of
   clean storyboard frame 1 marks the frame out of date.
3. **Video:** the base clip, made with MiniMax H3 Max from the frame and the
   source images, then each continuation. The storyboard frames never go to
   the clips, since they still show the video's own people and animals.
   Regenerate any generated clip, revise it with clip feedback, or choose an
   earlier version.
4. **Finish:** keeps the reviewed take and burns the saved
   watermark into the finished short, with its burned title when it has one:
   a big Thai headline and an English line under it, in the watermark's title
   block. Type them, or click **Write title**, which shows its estimate first
   and asks Astra for three options from the short's brief, title, beats and
   source images; pick one, edit it and save. A changed title finishes again
   from the reviewed take, never over the earlier burn. When the saved TikTok
   watermark template has no headline, the title stays disabled and Finish
   burns the handle alone. To add a cold open, use `/edit-cold-open` on the
   finished video.

Shorts saved before source images keep their main character on a read-only
**Character** tab and keep their stored prompts; they still continue and
finish.

**Revising.** A revision is an instruction of up to 2000 characters for a
storyboard frame, the frame or a clip. You can include @mentions: they become
cell labels (or bare addresses when unresolved) before the planner reads them.
Before the paid step, the planner's model rewrites that storyboard frame's
clean-up prompt, the frame prompt or the beat to follow it, replacing any
sentence the instruction contradicts instead of adding the instruction beside
it, and the short keeps the rewritten prompt. Revising uses `OPENAI_API_KEY`
and is billed like planning.

**Continuations.** A short longer than 15 seconds is planned as up to four
clips. Each clip after the first is an H3 Max Extend continuation of the clip
before it, with its own beat, estimate and approval. **Add a beat** on the
Video tab appends a clip while the short has fewer than 4 clips and at most 60
seconds. Changing the frame or an earlier clip marks the later clips out of
date, and the next approval regenerates from the first stale one.

**Always added.** Three rule lines are appended to every frame and clip prompt
and shown read-only under **Always added**: a candid phone photo look for the
frame, real-time phone footage filmed by someone off screen for the clips, and
silence. The person never speaks: no dialogue, voiceover, narration, singing
or music, while natural ambient sound stays. Planned beats call the camera the
camera, so the person holds a phone only when the brief gives them one.

**AI-tell check.** On request, **Check for AI tells** looks at the frame, or at
four frames of a clip's new footage, beside the first source image when there
is one, and lists up to five findings, warnings first: extra or fused fingers,
garbled text, waxy skin, warped objects, drift from the source image, or mouth
movement that reads as speech. It is billed like planning and never blocks a
step.

**Models and keys.** The storyboard clean-up, frames and clips use Nano
Banana 2.1, GPT Image 2.6 and MiniMax H3 Max through fal with `FAL_API_KEY`.
Planning, revising and the AI-tell check use `OPENAI_API_KEY`; a brief that
quotes the frame and every beat needs no planning, and without that key an
unquoted brief uses the plain plan described above. A short's clips and
finished video skip the speech-to-text pass that imported videos get, so no
transcription provider is called. H3 Max is billed per requested second, so
its estimates are lower bounds and read "at least". Nano Banana 2.1 and GPT
Image 2.6 are priced from fal's historical average, which needs
`FAL_ADMIN_API_KEY`; without it the clean-up and the frame show their estimate
as unavailable.

**Earlier goals.** Goals saved by earlier versions of `/goal` stay in their
notebooks as read-only tiles. Their panel lists their images and videos by
address, opens a cell when you click its address, and plays the finished video
when there is one. They can be dismissed but not generated again.

Goal notebooks keep separate rows for references (source images and storyboard
frames), the goal tile and its generators, image versions (clean storyboard
frames and frames), and clip versions. **Stop goal** stops the remaining work;
requests already submitted may still finish.

## On-screen graphics

`/graphics @a1` (also `/overlay` and `/osg`), the cell menu or the media dock
opens a video's graphics: layers of text, images, QR codes and shade, placed in
the platform's safe area and sized to the frame, so one look fits 9:16, 1:1 and
16:9. The editor previews with the same drawing code the render uses, saves as
you edit, and renders only when you press Render: into a new connected cell by
default, or in place.

- **Motion.** Each layer enters and exits with Fade, Slide (from or to the
  nearest edge), Pop or, for text, Words (one word after another). The fade
  length is how long the move takes.
- **Subtitles and graphics in one render.** When the video has a subtitle
  draft, **With subtitles** draws both in one pass into one new cell, with the
  subtitles on top. The subtitle editor has the matching **With graphics**
  switch.
- **Frame.** Reframe the render to 9:16, 1:1, 4:5 or 16:9, cropped around a
  focus point you drag or filled out with a blurred copy of the video. The
  preview shows the graphics on that frame, and a reframed render always makes
  a new cell.
- **Templates.** Save a look as a template of the book, make it the book's
  default look, or copy templates into another book. To give several videos
  one look, select their cells and choose **Apply graphics template** from the
  cell menu: each video keeps its typed text, credit, handle and frame, and
  **Render into new cells** makes a new cell per video.
- **Watermark.** `/watermark @a1` opens the editor on the platform's watermark
  look. `apply_watermark` and `/goal` finishing burn the saved watermark
  template through the same renderer.

`render_video` draws no overlay image and no graphics: put graphics on a video
with the editor or the watermark burn.

## Generation models

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

## Research books

`trending_research` manages one TikTok research schedule per country. The control book (`tiktok-th-research` for Thailand) stores the schedule, sighting ledger, source health and run history. At the daily cutoff, the scheduler creates a day book such as `tiktok-th-2026-10-28`: its notebook holds a summary at `@a1`, followed by ranked videos in column 1 and caption, metrics, author and source notes in column 2. Rank cells and the summary's download status follow each download through completion, failure and retry: a failed download keeps its rank and latest failure reason, and a successful retry clears it. A retained run whose completed downloads still show an old failure reason, as runs recorded before 0.4.0 can, is brought up to date on the scheduler's next tick without downloading anything again.

Create the Thailand schedule through the CLI relay. Every argument has a default, so the country can be omitted:

```bash
videobook run trending_research op=schedule
videobook run trending_research op=run
videobook run trending_research op=status
```

Defaults are platform `tiktok`, country `TH`, timezone `Asia/Bangkok`, cutoff `00:30` local time, four samples per day, top 10, a 24-hour `trending` window, lifetime-view ranking, promoted content excluded, and 30-day retention. A trending window means videos observed in the country's feeds during that period; the videos themselves can be older. Use `window=posted` to restrict their creation dates. Other countries require an explicit timezone when first scheduled. Updates preserve unspecified settings and the schedule identity. `op` defaults to `run`. `list`, `run`, and `status` use the only existing schedule when there is exactly one, and Thailand otherwise. `schedule` and `unschedule` default to Thailand even when another country exists.

The default source IDs are `endless` (country trending feed) and `tiktok-creative-center` (weekly organic cross-check and fallback). `omkar` is added only when `OMKAR_API_KEY` is set and the `@apicity/omkar` package is installed. With the key unset, schedules keep those two sources and `op=status` reports omkar as not configured. A sample makes one Omkar trending request for the schedule's country and does not retry that request. Set the omkar source option `explore` to true to add one Explore request for category `all`. The free plan allows 1,000 requests a month, and the default four daily samples stay under that. Promoted Omkar videos (`is_ad`) are excluded with the other promoted filters. One source failure does not stop the others. Downstream processing depends on its job integrations. Downstream preferences default to transcription off, with translation and vision analysis disabled. An update keeps a schedule's stored downstream preferences.

Retention runs once a day after the cutoff. It deletes day books older than `retention_days` (default 30) once their rank list, sources and download outcomes are copied into the control book history, and it never deletes the control book or a book missing from the run records. A day book renamed away from its date slug is kept and reported. Set `archive_top_clips=true` to archive each day book's completed clips through `archive_clip` before deletion; this needs `ELEVENLABS_API_KEY`, and a book whose archive fails is kept and retried the next day. Before a day book is deleted, the provider usage that `archive_clip` recorded in it, such as ElevenLabs transcription, is copied into the control book with every status kept. `get_book_usage` on the control book still reports that usage, and the history entry's spend is the total cost of its completed requests. The same run prunes the control book's sighting ledgers older than both `retention_days` and the 8 days a cut reads, so status and dated runs for earlier dates find an empty ledger.

`op=list` lists schedules; `op=status` adds ledger counts, source health, whether omkar is configured, recent failures, upcoming run times and retention (the next run, the last run's deletions, pruned ledger dates and errors, and recent deletions with their archive spend). `op=unschedule` disables automatic runs while preserving the books and history; re-enable with `op=schedule enabled=true`. `op=run` samples immediately. Add `date=2026-10-28` to enqueue a cut for that local date and its configured cutoff using the ledger currently available; completed cuts are idempotent. The chat command `/trending schedule` creates the Thailand schedule. `/trending` and `/trending TH` sample, and `/trending TH 2026-10-28` cuts that date. `/trending status` inspects the only schedule, or Thailand when more than one exists. A disabled schedule must be enabled before a manual run.

## Storage

Each book owns an isolated `videobook-engine` v5.9.0 schema-v28 root under
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

### Portable book archives

Export a complete editable book, upload the archive yourself, and import it
on another machine running a compatible Videobook release:

```bash
videobook export-book pig --out ~/Downloads/pig.videobook.tar.gz
videobook import-book /path/to/pig.videobook.tar.gz
```

Both commands honor `--library` and `--home`. For this checkout's development
library, use `--library ./runtime/books`. Add `--json` for a machine-readable
result. Export prints the archive size and SHA-256; verify the checksum after
uploading. The commands coordinate with the running local app, or take
exclusive library ownership when it is stopped.

Export requires an idle book. It briefly fences that book for a consistent
snapshot; editing can continue while the CLI compresses the pinned snapshot.
The archive preserves identities, notebook graphs, media versions, history,
job records, and posting records. Canonical media appears once; model caches,
duplicate workspaces, source connection configuration, and application
credentials are excluded.

Import verifies inventory, catalog integrity, and checksums before atomically
adding the book. Existing names/IDs are rejected. Format v1 requires schema 28.
Imported publishing, research, and metrics schedules retain their settings
and history but start paused. Explicitly resume them with:

```bash
videobook run set_book_automation book_id=<imported-book-id> paused=false
```

The source stays intact. Delete it separately after checking the imported book.
Interrupted commands clean their staging; abandoned workspaces are recovered
when their owning process has exited.

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
The bundled arm64 Mac `ffprobe` is FFmpeg 4.4.1, the newest published build.
Probers older than FFmpeg 6.0 read the format duration from the `mvhd` atom, so
a file whose tracks all start late reports that delay as extra duration.
`videobook doctor` warns about such a prober; set `VIDEOBOOK_FFPROBE_PATH` to a
newer `ffprobe` to avoid it.
`VIDEOBOOK_YTDLP_COOKIES` names a Netscape-format cookies file for TikTok
downloads. Each download gives yt-dlp a private copy, so the file only needs to
be readable and is never rewritten; `videobook doctor` shows its path, never its
contents, next to the impersonation targets the yt-dlp build supports. TikTok
downloads use `--impersonate chrome` when available, start at least 5 seconds
apart within a book, and retry HTTP 403, 429, 5xx and network failures up to
three times with backoff. A failed download keeps its reason, the failure class
and the tail of yt-dlp's message, in the artifact's `download-failure` metadata.

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
Work lands on `main`; `stable` is the release branch and always points at the
last released commit. A release runs the gates on `main`, fast-forwards
`stable` to that commit, publishes, and tags `v<version>` on `stable`. `stable`
only moves by fast-forward from `main`, and the release refuses to start if it
has diverged. A GitHub ruleset keeps `main` and `stable` from being deleted.

Set the version in `server/package.json`, rename the changelog's Unreleased
section to that version, and commit on `main`. Then:

```bash
npm run release -- 0.1.0 --dry-run   # every gate, then npm publish --dry-run
npm run release -- 0.1.0             # publish the tested tarball, verify it, fast-forward stable, tag locally
npm run release -- 0.1.0 --push      # push stable, the tag and main, create the GitHub release
```

On the Gas City box, the `mol-videobook-release` formula
(`.beads/formulas/`, served through this repository's `pack.toml` as the
`videobook-release` import) runs the whole release: it writes the version and
changelog commit in a fresh clone, waits for green CI on `main`, then runs
`npm run release -- <version> --push`:

```bash
gc sling videobook/core.control-dispatcher mol-videobook-release --formula --var version=0.4.1
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
