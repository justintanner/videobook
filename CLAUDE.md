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

**Domain/storage layer:** `videobook-engine` 4.2.0, schema 18 — each book has an isolated UUIDv7 root under `VIDEOBOOK_LIBRARY_DIR`, with its own Dolt-native catalog, files/CAS, metadata, history, notebooks, canonical primary sequence, and runtime jobs. Per-book schedules use engine runtime settings; only application credentials such as X OAuth tokens live at `VIDEOBOOK_APP_STATE_PATH`.

## TypeScript

Strict mode enabled. Uses project references: `tsconfig.app.json` (src code) and `tsconfig.node.json` (Vite/node config). Target ES2022 with bundler module resolution.

## Linting

Flat ESLint config (`eslint.config.js`) with typescript-eslint, react-hooks, and react-refresh plugins. Only lints `*.ts`/`*.tsx` files. `dist/` is ignored.

## Filesystem Operations

IMPORTANT: All book, artifact, and managed-file operations MUST use a scoped `Engine` from `createEngine()` in `videobook-engine`. Direct `node:fs` is only for explicit scratch paths returned by the engine or unrelated application configuration. Persist completed scratch outputs with `engine.files.writeFromPath()` or `engine.files.ingestWorkspace()`.

## External API Calls

IMPORTANT: All external API calls from the server MUST use `@apicity` provider packages. Never call third-party AI/LLM APIs directly with `fetch` or other HTTP clients — always go through the corresponding `@apicity` provider (e.g., `kimicoding()` from `@apicity/kimicoding`). API keys are stored in `.env` and loaded via `dotenv/config`.

## Job Queue

IMPORTANT: All long-running or async processes on the server MUST be submitted to the job queue. Never run long-running operations directly in MCP tool handlers — always enqueue them via the `queue` singleton from `server/src/queue.ts`. This ensures concurrency control, retries, and graceful shutdown. Use `queue.enqueueAndWait()` when the tool needs to return the result, or `queue.enqueue()` for fire-and-forget.

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


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
