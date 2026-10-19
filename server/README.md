# videobook

Videobook is a local-first notebook studio for generative media: images,
videos, audio, prompts, characters and scenes live as cells in an executable
graph, and every change is recorded as a revision. This package installs one
`videobook` command that runs the Videobook MCP server three ways:

- with the web UI at `http://127.0.0.1:3001/`
- headless, serving MCP and the HTTP API only
- over stdio, for agent hosts such as Claude Code

## Requirements

- Node.js 22 or newer.
- macOS (Apple Silicon or Intel) or Linux (x64 or arm64). Windows x64 has
  every native binary but is untested.
- About 1.2 GB of disk. Installing downloads the ffmpeg and yt-dlp binaries
  from GitHub, and the first video render downloads Chrome Headless Shell
  (about 150 MB) into `~/.cache/videobook/remotion`.
- `ffmpeg` and `ffprobe` on `PATH` are recommended. Apple Silicon and Linux
  arm64 always use the system `ffprobe`, and every platform falls back to the
  system binaries when the bundled ones are missing.

## Install

```bash
npm install -g videobook
videobook doctor
```

npm 12 and newer skip dependency install scripts unless you approve them.
Approve the six that videobook needs, either per install or once for your
user:

```bash
npm install -g videobook --allow-scripts=ffmpeg-static,ytdlp-nodejs,@dolthub/doltlite,usearch,onnxruntime-node,esbuild
npm config set allow-scripts=ffmpeg-static,ytdlp-nodejs,@dolthub/doltlite,usearch,onnxruntime-node,esbuild --location=user
```

- `ffmpeg-static` downloads ffmpeg, which every media operation needs.
- `ytdlp-nodejs` downloads yt-dlp, which downloading videos from URLs needs.
- `@dolthub/doltlite`, `usearch` and `onnxruntime-node` use prebuilt native
  binaries and only compile or fetch extras on unusual platforms.
- `esbuild` checks its platform binary for the Remotion renderer.

`videobook doctor` reports anything missing and prints the fix.

## Run

```bash
videobook                      # same as videobook serve
videobook serve --open         # serve MCP and the web UI, open a browser
videobook serve --headless     # MCP and HTTP API only
videobook mcp                  # MCP over stdio for agent hosts
videobook run list_books       # call one MCP tool and print its result
videobook run create_book name=demo
videobook tools                # list tools and their parameters
videobook gc-books             # reclaim catalog storage in every book
videobook doctor               # check Node, binaries, native modules and keys
videobook --version
```

Every command accepts `--port <n>` (default 3001), `--library <dir>`,
`--home <dir>` and `--log-level <silent|error|warn|info|debug>`. Tool
arguments are `key=value`; values that parse as JSON are passed as JSON. Exit
codes are 0 for success, 1 for a failure and 2 for a usage error.

## Agent hosts

```bash
claude mcp add videobook -- videobook mcp
```

Other hosts take the same command, for example
`{ "command": "videobook", "args": ["mcp"] }`. stdio accepts clients that
start with the 2025-era `initialize` and clients that use MCP 2026-07-28.
While `videobook serve` runs, HTTP clients can connect to
`http://127.0.0.1:3001/mcp`, which speaks MCP 2026-07-28 only.

## One server per library

A library is owned by one videobook process at a time, recorded in
`<library>/.videobook-server.json`. A second `videobook serve` for the same
library exits and names the running URL. `videobook mcp` and `videobook run`
relay to the running server when there is one; otherwise they start one in
their own process, which `videobook mcp` keeps serving HTTP and the web UI
for as long as the agent host keeps it open. `videobook gc-books` refuses to
run while a server owns the library.

## Data and configuration

Installed data lives in `~/.videobook`:

- `books/`, the library of books
- `app-state.json`, connected X and Dropbox accounts
- `.env`, provider keys, also editable from Settings in the web UI

`VIDEOBOOK_HOME` or `--home` moves all three. `VIDEOBOOK_LIBRARY_DIR`,
`VIDEOBOOK_APP_STATE_PATH` and `VIDEOBOOK_ENV_PATH` move one each; `--home`
overrides any of them inherited from your shell. Set `VIDEOBOOK_HOME` and
`VIDEOBOOK_ENV_PATH` in the environment, not in `.env`, because they decide
which `.env` is read.

Provider keys: `OPENAI_API_KEY`, `KIE_API_KEY`, `XAI_API_KEY`, `FAL_API_KEY`,
`DASHSCOPE_API_KEY`, `ELEVENLABS_API_KEY`, `KIMI_CODING_API_KEY`,
`X_CLIENT_ID` and `X_CLIENT_SECRET`, `DROPBOX_CLIENT_ID` and
`DROPBOX_CLIENT_SECRET`, and the `B2_*` storage settings. The server starts
without any of them; tools that need one report which.

Caches live in `~/.cache/videobook`. Other settings: `PORT`,
`VIDEOBOOK_FFMPEG_PATH`, `VIDEOBOOK_FFPROBE_PATH`,
`VIDEOBOOK_REMOTION_CACHE_DIR`, `VIDEOBOOK_MODEL_CACHE_DIR`,
`VIDEOBOOK_DOWNLOADS_DIR` and `VIDEOBOOK_LOG_LEVEL`.

## Platform notes

- macOS on Apple Silicon is the primary platform. The bundled ffprobe is an
  Intel build, so install `ffprobe` with `brew install ffmpeg`.
- macOS on Intel works, but ONNX Runtime has no Intel Mac build, so semantic
  search is unavailable there.
- Linux x64 is supported. Linux arm64 needs `ffprobe` from the system package
  manager.
- Windows x64 is untested.

## Security

Videobook is a local, single-user service. It listens on `127.0.0.1` only and
accepts requests from loopback hosts and origins. It has no user
authentication, so do not expose it to other machines or share it between
users.

## License

MIT
