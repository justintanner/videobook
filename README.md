# Videocity

Video-first content management SPA built with React 19 + TypeScript + Vite 7, using MCP (Model Context Protocol) as the API layer.

## Getting Started

```bash
npm install
npm run dev        # Start frontend + MCP server
```

## Architecture

- **Frontend** (`src/`): React SPA connecting to MCP server via `use-mcp` hook
- **MCP Server** (`server/src/`): Express app exposing tools at `POST /mcp` (port 3001)
- **Filesystem** (`videocity-engine`): npm dependency providing project/asset management with git versioning

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server + MCP server concurrently |
| `npm run dev:client` | Start Vite dev server only |
| `npm run dev:server` | Start MCP server only (port 3001) |
| `npm run build` | Type-check then Vite build |
| `npm run build:server` | Compile server TypeScript |
| `npm run lint` | Run ESLint |
| `npm run test` | Run vitest integration tests |
| `npm run preview` | Preview production build |

## Testing

Integration tests use vitest with real dependencies (no mocks). Tests live in `tests/` and `server/src/tools/`.

```bash
npm test           # Run all tests
npm run test:watch # Watch mode
```

## Video Editing Commands & MCP Tool Contracts

| Canonical Slash Command | Legacy Alias | MCP Tool | Exposure | Description & Example |
|-------------------------|--------------|----------|----------|-----------------------|
| `/trim-video` | `/trim` | `trim_video` | Direct MCP | Trim video clip: `/trim-video @hero 0:05 0:12` |
| `/trim-audio` | - | `trim_audio` | Direct MCP | Trim audio clip: `/trim-audio @voice 0:00 0:30` |
| `/split-chunks` | `/even-split` | `split_video_by_durations` | Direct MCP | Split video into target duration chunks: `/split-chunks @clip 10 15` |
| `/overlay` | `/osg` | `set_video_overlay` | Direct MCP / UI | Position on-screen graphic overlay: `/overlay @clip @logo` |
| `/apply-cuts` | - | `apply_cuts` | Direct MCP | Apply cut ranges in place: `/apply-cuts @clip 0-5 10-15` |
| `/extract-frame` | - | `extract_frame` | Direct MCP | Extract frame at timestamp: `/extract-frame @clip 2.5` |
| `/transcript` | - | `read_transcript` | Direct MCP | Read asset transcript: `/transcript @interview` |
| `/translate-subs` | - | `translate_subtitles` | Direct MCP | Translate subtitles: `/translate-subs @clip es` |
| `/render-video` | `/render` | `render_video` | Direct MCP | Render video asset across orientations: `/render-video @clip portrait` |
| `/final` | - | `render_timeline` | Direct MCP | Export project timeline: `/final landscape` |
| `/audio-settings` | `/audio` | - | UI Viewer | Viewer volume and fade settings: `/audio-settings volume 80` |

Legacy tool names (`even_split`, `set_osg`, `render`, `render_settings`, `edit_timeline`, `create_watermark`) and legacy slash commands (`/trim`, `/even-split`, `/osg`, `/audio`) remain fully supported as compatibility aliases.

