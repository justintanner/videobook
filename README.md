# Videobook

Videobook is a local-first notebook studio for generative media. Images, videos,
prompts, characters, and scenes are first-class cells in an executable graph,
while every project mutation is recorded as an immutable DoltLite revision.

The repository preserves the complete Videocity history and its 211 fork-time
MCP endpoints. Videobook adds notebook, reusable-entity, revision, and storage
tools without removing those existing automation contracts.

## Repositories

- `~/videobook` — React frontend, MCP server, providers, and job workers
- `~/videobook-engine` — public `videobook-engine` package and storage API
- `~/videocity` and `~/videocity-engine` — unchanged predecessor repositories

## Product model

A project contains one or more notebooks. A notebook is a directed graph of
typed cells:

- prompt
- character
- scene
- image
- video

Connections carry outputs into named inputs. Runs are explicit and queued, and
their cell order and resulting asset/entity references are recorded. New
projects begin with the `nb-scratch` notebook.

The frontend is a new notebook-first workspace with stage bands, a typed cell
palette, reusable entity views, revision history, storage health, jobs,
providers, and diagnostics.

## Storage

`videobook-engine` keeps durable, rewindable metadata and file manifests in one
embedded DoltLite catalog at `VIDEOBOOK_DATA_DIR/videobook.db`. Media bytes live
in a SHA-256 content-addressed cache and can be published to B2 under immutable
keys. Runtime jobs, leases, pending tasks, locks, failures, and publication
state are unversioned tables in that same Dolt database.

Rewind is forward-only: Videobook materializes the selected historical state,
then creates a new revision. It never checks out detached history, rewrites
history, or deletes canonical B2 objects.

The engine materializes UUID-addressed scratch workspaces under
`VIDEOBOOK_WORKSPACE_DIR` for ffmpeg and Remotion. `/files` resolves content
through the engine; workspace paths are not an authoritative data model.

## Development

Requirements:

- Node.js 20 or newer
- ffmpeg
- 1Password CLI for the checked-in `.env.tpl` workflow

Install both repositories:

```bash
cd ~/videobook-engine
npm install

cd ~/videobook
npm install
cd server && npm install
```

Run the app and MCP server:

```bash
npm run dev
```

The frontend is served on port 5173 and the MCP server on port 3001.

## Environment

The storage-specific variables are:

```text
VIDEOBOOK_DATA_DIR
VIDEOBOOK_WORKSPACE_DIR
VIDEOBOOK_OBJECT_PREFIX
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
