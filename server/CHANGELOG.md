# Changelog

All notable changes to the `videobook` npm package are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
