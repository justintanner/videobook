# Clipfirst

Video-first content management SPA built with React 19 + TypeScript + Vite 7, using MCP (Model Context Protocol) as the API layer.

## Getting Started

```bash
npm install
npm run dev        # Start frontend + MCP server
```

## Architecture

- **Frontend** (`src/`): React SPA connecting to MCP server via `use-mcp` hook
- **MCP Server** (`server/src/`): Express app exposing tools at `POST /mcp` (port 3001)
- **Filesystem** (`clipfirst-engine`): Local dependency providing project/asset management with git versioning

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
