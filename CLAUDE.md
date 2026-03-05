# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Start both Vite dev server and MCP server concurrently
- `npm run dev:client` — Start Vite dev server only
- `npm run dev:server` — Start MCP server only (tsx watch, port 3001)
- `npm run build` — Type-check with `tsc -b` then bundle with Vite
- `npm run build:server` — Compile MCP server TypeScript
- `npm run lint` — Run ESLint across the project
- `npm run preview` — Preview the production build locally

## Architecture

React 19 + TypeScript + Vite 7 SPA using MCP (Model Context Protocol) as the API layer.

**Frontend:** `index.html` → `src/main.tsx` → `src/App.tsx`. Connects to MCP server via `use-mcp` hook. Vite proxies `/mcp` to the server in dev.

**MCP Server:** `server/src/index.ts` — Express app exposing `POST /mcp` with `StreamableHTTPServerTransport` (stateless). Tools are registered in `server/src/tools/`. The server is also accessible to external MCP clients (Claude Desktop, etc.) at `http://localhost:3001/mcp`.

## TypeScript

Strict mode enabled. Uses project references: `tsconfig.app.json` (src code) and `tsconfig.node.json` (Vite/node config). Target ES2022 with bundler module resolution.

## Linting

Flat ESLint config (`eslint.config.js`) with typescript-eslint, react-hooks, and react-refresh plugins. Only lints `*.ts`/`*.tsx` files. `dist/` is ignored.
