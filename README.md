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

Each book owns an isolated `videobook-engine` v3.0.0 schema-v5 root under
`VIDEOBOOK_LIBRARY_DIR/<book UUIDv7>/`. That root holds its embedded DoltLite
catalog, content-addressed objects, managed files, notebook graph, timeline,
history, and runtime tables. Media bytes can be published to B2 under immutable
keys. Application-wide settings such as provider credentials and X OAuth tokens
live separately at `VIDEOBOOK_APP_STATE_PATH`.

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

Install both repositories:

```bash
cd ~/videobook-engine
npm install

cd ~/videobook
npm install
cd server && npm install
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
