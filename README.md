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

Slash options below are positional; `project_slug` is injected by the client for direct commands. An omitted slash command means the endpoint is intentionally internal. UI and composite commands open a deterministic editor instead of routing through chat.

### Clip Editing and Analysis

| MCP Endpoint | Slash Command | Exposure | Slash Options / Adapter | Purpose |
|--------------|---------------|----------|-------------------------|---------|
| `trim_video` | `/trim-video` (`/trim` legacy) | Direct | `asset start? end?`; `trim` adapter | Keep a video time range in place |
| `trim_audio` | `/trim-audio` | Direct | `aud-* start? end?`; `trim` adapter | Keep an audio time range in place; rejects `vid-*` |
| `split_video` | `/split` | UI | `asset at?` | Open the frame-accurate split editor |
| `split_video_by_durations` | `/split-chunks` (`/even-split` legacy) | Direct | `asset target_secs[]?` (default `7`) | Create targeted chunks and a leftover |
| `even_split` | — | Internal legacy | Use `split_video_by_durations` | Compatibility endpoint for the old misleading name |
| `pad_video` | `/pad` | Direct | `asset padding` | Append black frames and silence |
| `crop_video` | `/crop` | UI | `asset ratio?` | Open the interactive video crop editor |
| `crop_image` | `/crop` | UI | `asset ratio?` | Open the interactive image crop editor |
| `invert_image` | `/invert` | Direct | `asset` | Invert image colors in place |
| `set_video_overlay` | `/overlay` (`/osg` legacy) | UI | `video image?`, then position and size | Configure an on-screen graphic |
| `set_osg` | — | Internal legacy | Use `set_video_overlay` | Compatibility endpoint for the old jargon name |
| `animate_keywords` | `/keywords` | Direct | `video words[]?` or `on max? linger?` / `off`; `keywords` adapter | Configure transcript-timed keyword graphics |
| `detect_scenes` | `/detect-scenes` | Direct | `video` | Detect visual scene boundaries |
| `suggest_cuts` | `/suggest-cuts` | Direct | `video` | Suggest removable ranges |
| `analyze_jokes` | `/analyze-jokes` | Direct | `video` | Analyze joke-aware edit points |
| `suggest_sfx` | `/suggest-sfx` | Direct | `video` | Suggest sound-effect placements |
| `apply_cuts` | `/apply-cuts` | Direct | `video start-end[]`; `apply_cuts` adapter | Remove multiple ranges in place |
| `apply_sfx` | `/apply-sfx` | Direct | `video timestamp type description`; `apply_sfx` adapter | Generate and mix a sound effect |
| `inject_first_frame` | `/inject-first-frame` | Direct | `target image orientation?` | Replace frame zero while preserving timing and audio |
| `extract_first_frame` | `/extract-first-frame` | Direct | `video` | Create an image from the first frame |
| `extract_last_frame` | `/extract-last-frame` | Direct | `video` | Create an image from the last frame |
| `extract_frame` | `/extract-frame` | Direct | `video timestamp` | Create an image from a chosen timestamp |
| `reverse_video` | `/reverse` | Direct | `video` | Reverse video playback |
| `change_video_speed` | `/speed` | Direct | `video multiplier-or-duration`; `change_speed` adapter | Change playback speed or target duration |
| `timewarp_video` | `/timewarp` | Direct | `video start-end factor`; `timewarp` adapter | Retime a selected scene |
| `sync_video_to_audio` | `/sync-audio` | Direct | `video mappings`; `sync_audio` adapter | Retime video using transcript or numeric audio anchors |

### Audio and Transcripts

| MCP Endpoint | Slash Command | Exposure | Slash Options / Adapter | Purpose |
|--------------|---------------|----------|-------------------------|---------|
| `extract_audio` | `/extract-audio` | Direct | `video` | Extract a soundtrack as an audio asset |
| `extend_audio` | `/extend-audio` | Direct | `audio duration prompt?` | Generate a matching audio continuation |
| `remove_sound` | `/remove-sound` | Direct | `asset sound-description` | Silence described transcript-tagged events |
| `audio_boost` | `/audio-boost` | Direct | `asset multiplier` (`1`–`4`) | Increase audio volume in place |
| `audio_mix` | `/audio-mix` | Direct | `target layer volume` (`0`–`100`) | Mix an audio layer into an asset |
| `replace_video_audio` | `/replace-audio` | Direct | `video audio` | Replace a video soundtrack |
| `splice_video` | `/splice` | Direct | `first second overlap` | Splice videos with an optional overlap search |
| `smooth_scene_concat` | `/scene-concat` | Direct | `first second transition?` | Join scenes with aligned boundary audio |
| `transcribe` | `/transcribe` | Direct | `asset` | Generate a timed transcript |
| `read_transcript` | `/transcript` | Direct | `asset` | Read a stored transcript |
| `translate_subtitles` | `/translate-subs` | Direct | `asset language`; `translate_subtitles` adapter | Translate timed subtitles |
| `clean_video_audio` | `/clean-audio` | Direct | `video add_light_music?` | Clean a soundtrack while preserving important sounds |
| `isolate_vocals` | `/vocals` | Direct | `asset` | Isolate vocals |

### Rendering, Timeline, and Settings

| MCP Endpoint | Slash Command | Exposure | Slash Options / Adapter | Purpose |
|--------------|---------------|----------|-------------------------|---------|
| `render_video` | `/render-video` (`/render` legacy) | Direct | `video orientation?`; omit orientation for all three | Render landscape, portrait, or square outputs |
| `render` | — | Internal legacy | Use `render_video` | Compatibility render endpoint |
| `render_timeline` | `/final` | Direct | `orientation?` | Export the assembled project timeline |
| `get_timeline` | — | Internal | Raw timeline read schema | Read timeline state for programmatic clients |
| `set_timeline` | — | Internal | Full timeline payload | Replace timeline state for programmatic clients |
| `edit_timeline` | — | Internal legacy | Use `set_timeline` | Compatibility endpoint for timeline replacement |
| `assign_slot` | `/assign` | Direct | `asset slot` | Assign an asset to a timeline slot |
| `unassign_slot` | `/unassign` | Direct | `slot` | Clear a timeline slot |
| `insert_timeline_slot` | `/insert-slot` | Direct | `slot before\|after` | Insert an empty timeline slot |
| `remove_timeline_slot` | `/remove-slot` | Direct | `slot` | Remove and compact a timeline slot |
| `add_timeline_audio` | `/audio-add` | UI | `asset` plus placement settings | Add an audio layer to the timeline |
| `move_timeline_audio` | `/audio-move` | UI | `clip` plus new placement | Move a timeline audio layer |
| `remove_timeline_audio` | `/audio-remove` | UI | `clip` | Remove a timeline audio layer |
| `update_timeline_audio` | `/audio-set` | UI | `clip` plus volume/fade settings | Update timeline audio settings |
| `get_render_settings` | `/settings` | UI | Viewer controls | Read and edit render settings through the viewer |
| `render_settings` | — | Internal legacy | Use `get_render_settings` | Compatibility endpoint for the old ambiguous name |
| `create_watermark_card` | `/watermark` | Composite | `video?`, then QR and handle fields | Create and apply a watermark end card |
| `create_watermark` | — | Internal legacy | Use `create_watermark_card` | Compatibility watermark endpoint |

Viewer-only `/audio-settings` (`/audio` legacy) controls clip volume and fades and does not call an MCP endpoint. Legacy slash aliases remain callable but are marked deprecated and hidden from command pickers. The executable source of truth is `server/src/tools/video-editing-command-contract.ts`; contract tests enforce tool coverage, alias uniqueness, adapter availability, schema-valid examples, and synchronized defaults.
