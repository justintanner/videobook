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

The frontend is a green notebook-first workspace with book and notebook
pickers, a typed cell canvas, a timeline, an asset library, jobs, history,
storage health, and provider settings.

## Storage

Each book owns an isolated `videobook-engine` v5.3.0 schema-v24 root under
`VIDEOBOOK_LIBRARY_DIR/<book UUIDv7>/`. That root holds its embedded DoltLite
catalog, content-addressed objects, managed files, notebook graph, primary sequence,
history, and runtime tables. Media bytes can be published to B2 under immutable
keys. Per-book scheduled posts live in ignored engine runtime settings. Only
application-wide credentials, including X OAuth tokens, live separately at
`VIDEOBOOK_APP_STATE_PATH`; that file is never part of a public book record.

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
