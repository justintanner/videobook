# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Start both Vite dev server and MCP server concurrently
- `npm run dev:client` — Start Vite dev server only
- `npm run dev:server` — Start MCP server only (tsx watch, port 3001)
- `npm run build` — Type-check with `tsc -b` then bundle with Vite
- `npm run build:server` — Compile MCP server TypeScript
- `npm run lint` — Run ESLint across the project
- `npm run test` — Run vitest (integration tests with real dependencies)
- `npm run preview` — Preview the production build locally

## Architecture

React 19 + TypeScript + Vite 7 SPA using MCP (Model Context Protocol) as the API layer.

**Frontend:** `index.html` → `src/main.tsx` → `src/App.tsx`. Connects to MCP server via `use-mcp` hook. Vite proxies `/mcp` to the server in dev.

**MCP Server:** `server/src/index.ts` — Express app exposing `POST /mcp` with `StreamableHTTPServerTransport` (stateless). Tools are registered in `server/src/tools/`. The server is also accessible to external MCP clients (Claude Desktop, etc.) at `http://localhost:3001/mcp`.

**Filesystem Layer:** `clipfirst-fs` (local dependency at `../clipfirst-fs`) — provides project/asset management with git versioning. All project, asset, and file operations go through `createFs()` from this package.

## TypeScript

Strict mode enabled. Uses project references: `tsconfig.app.json` (src code) and `tsconfig.node.json` (Vite/node config). Target ES2022 with bundler module resolution.

## Linting

Flat ESLint config (`eslint.config.js`) with typescript-eslint, react-hooks, and react-refresh plugins. Only lints `*.ts`/`*.tsx` files. `dist/` is ignored.

## Filesystem Operations

IMPORTANT: All project, asset, and file operations MUST use the `clipfirst-fs` package. Never use `node:fs` directly for managing projects, assets, or their files — always go through `createFs()` from `clipfirst-fs`. This ensures git versioning, proper directory structure, and consistent error handling via `Result` types.

## External API Calls

IMPORTANT: All external API calls from the server MUST use `@nakedapi` provider packages. Never call third-party AI/LLM APIs directly with `fetch` or other HTTP clients — always go through the corresponding `@nakedapi` provider (e.g., `kimicoding()` from `@nakedapi/kimicoding`). API keys are stored in `.env` and loaded via `dotenv/config`.

## Best Practices

### State Management
- **Local-first**: state starts in the component that uses it; lift only when sharing is proven necessary
- **Derive, don't store**: compute filtered/transformed values during render with `useMemo`; never duplicate MCP data into separate state
- **Single MCP connection**: share `useMcpConnection()` via props or Context; never create parallel instances
- **Prop drill first**: prefer explicit props for 3 levels or fewer before reaching for Context or Zustand

### useEffect Minimization
- **No tool calls in effects**: invoke MCP tools from event handlers or explicit action hooks, not `useEffect`
- **No state sync from props**: derive directly during render instead
- **Always clean up**: subscriptions and listeners must return cleanup functions
- Reserve `useEffect` for genuine side effects (analytics, imperative DOM via refs)

### MCP Data Layer
- The `use-mcp` hook owns connection lifecycle, tool discovery, and invocation — treat its state as read-only
- Wrap tool invocations in **domain-specific custom hooks** (e.g., `useSearchTool`) that encapsulate tool names, argument construction, and result parsing
- Guard tool calls with `state === "ready"` checks
- On the server, tools return errors as content (`{ isError: true, content: [...] }`) rather than throwing

### Component Design
- Extract data fetching and logic into custom hooks; components receive data via props and render JSX
- Single-purpose hooks with descriptive names (`useSearchTool`, not `useUtils`)
- Use `useMemo`/`useCallback` only for expensive computations or functions passed to memoized children
- Avoid inline object/array creation in JSX props; use stable `key` props (unique IDs, not indices)
