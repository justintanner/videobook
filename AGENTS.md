# AGENTS.md

Guidance for AI coding agents working in the Videobook repository.

## Agent Instructions

`AGENTS.md` is the canonical project instruction file for every coding agent, including Claude Code. Keep shared guidance here; do not recreate a separate `CLAUDE.md`. See [README.md](README.md#coding-agents) for Claude Code compatibility and instruction-loading settings.

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev + MCP server concurrently |
| `npm run dev:client` | Start Vite only (port 5173) |
| `npm run dev:server` | Start MCP server only (port 3001) |
| `npm run build` | Type-check + Vite build |
| `npm run build:server` | Compile server TS to server/dist/ |
| `npm run lint` | ESLint all *.ts/*.tsx files |
| `npm run test` | Run all vitest integration tests |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:e2e` | E2E tests with vitest.e2e.config.ts |
| `npm run preview` | Preview the production build locally |
| `npm run benchmark:startup` | Replicate server `start()` phase by phase (skips `queue.start()`); print a per-phase table and write JSON to argv[2]; `--assert-listen-ms` / `--assert-ready-ms` fail when those budgets are exceeded |

### Running a Single Test
- `npx vitest run tests/v2/notebook-domain.test.ts`
- `npm run test -- tests/v2/notebook-domain.test.ts`
- `npx vitest run -t "persists a graph"` (by test name)

## Git Workflow

This repository explicitly opts into the Beads **team-maintainer** profile (`agent.profile: "team-maintainer"` in `.beads/config.yaml`): agents commit their own completed work.

- **Work directly on `main`.** No feature branch is needed by default. Creating a branch is allowed whenever the work benefits from isolation (large refactor, risky experiment, parallel agents touching the same files) — no permission required; merge it back into `main` when done.
- **Done means lint + test + commit.** Every completed piece of work ends with `npm run lint` and `npm run test` passing, followed by a `git commit` with a descriptive message. Never leave finished work uncommitted at handoff.
- **Never commit red.** If lint or tests fail, fix them before committing; if genuinely blocked, file a bead describing the failure and hand off without committing the broken state.
- **Pushing is not part of done.** Run `git push` / `bd dolt push` only when explicitly asked.

## Architecture

- **Frontend (`src/`)**: React 19 + TypeScript + Vite 7 SPA. Entry: `index.html` → `main.tsx` → `App.tsx`. Uses `useMcpConnection()` over `@modelcontextprotocol/client` to connect to `/mcp` with MCP `2026-07-28` pinned. Vite proxies `/mcp` to the server in dev.
- **Backend (`server/src/`)**: Express MCP server on port 3001. Entry: `server/src/index.ts`. The modern-only `createMcpHandler` endpoint rejects legacy protocol traffic. Tools in `server/src/tools/*.ts` are registered via `server/src/tools/index.ts`.
- **Domain/storage (`videobook-engine` 5.4.5, schema 25)**: one isolated UUIDv7 engine root per book, providing Dolt-native artifact, file/CAS, metadata, history, notebook, canonical-sequence, and runtime-job operations. All managed data goes through the scoped book `Engine`. Project names are lowercase ASCII slugs with single hyphens, normalized with `videobook-engine/book-slug` before persistence and uniqueness checks. Artifacts and cells carry no slugs — identity is `artifact_id`/`cell_id` (UUIDv7) plus content-addressed `object_hash`, the user-facing handle is the grid address `@a1`-`@bl8` (lettered rows a-z, aa-az, ba-bl; numbered columns 1-8, so the top row reads `@a1` through `@a8`), and `label` is display-only text that is never parsed or looked up.
- Generation-cell prompts name connected inputs by slot (`@image1`, `@video1`, `@audio1`, `@firstframe`, `@lastframe`; see `server/src/generation-input-mentions.ts`), never by grid address, so moving cells never changes a prompt.
- Book roots live under `VIDEOBOOK_LIBRARY_DIR`. Per-book schedules use engine runtime settings; only application credentials such as X OAuth tokens live at `VIDEOBOOK_APP_STATE_PATH`.

## Code Style

### TypeScript
- **Strict mode enabled** - all strict compiler flags on
- **Target:** ES2022 (client), ES2023 (Vite config)
- **Module:** ESNext with bundler resolution (Node16 for server)
- **erasableSyntaxOnly:** true - explicit `type` imports only
- **verbatimModuleSyntax:** true - no `import type { ... }` auto-conversion
- Use explicit named types (no `any`)
- Keep functions flat - extract helpers, avoid deep nesting
- Prefer functional style/pure functions when objects add no value

### Imports & Exports
- Always use explicit `type` keyword for type imports: `import type { Foo } from './foo'`
- Prefer named exports: `export function useHook()`
- Use `.js` extensions in server imports (Node16 resolution)

### Naming
- **Components:** PascalCase (e.g., `McpStatus.tsx`)
- **Hooks:** camelCase with `use` prefix (e.g., `useMcpConnection.ts`)
- **Functions:** camelCase, descriptive verbs (e.g., `registerHelloTool`)
- **Types/Interfaces:** PascalCase (e.g., `McpServer`)
- **Files:** Match the default export name

### Formatting

**Client (`src/`):**
- Single quotes, no semicolons, 2-space indent

**Server (`server/src/`):**
- Double quotes, semicolons required, 2-space indent

### Error Handling
- Prefer returning error states from hooks (e.g., `{ error, retry }`)
- Use early returns for guard clauses
- MCP tools return structured errors rather than throwing: `{ isError: true, content: [{ type: "text", text: "..." }] }`

### Linting
- ESLint 9 flat config with typescript-eslint, react-hooks, react-refresh
- Ignores: `dist/` directories
- Only lints `*.ts` and `*.tsx` files

**IMPORTANT:** DO NOT ADD COMMENTS unless asked. Never log or commit secrets.

## Key Rules

### Filesystem Operations
**ALWAYS use `videobook-engine`** — never `node:fs` for books/assets:

Direct `node:fs` is only for explicit scratch paths returned by the engine or unrelated application configuration. Persist completed scratch outputs with `engine.files.writeFromPath()` or `engine.files.ingestWorkspace()`.

```typescript
import { createEngine } from "videobook-engine";
const engine = createEngine({
  rootDir: "/path/to/book-root",
  initialBookName: "my-book",
});
const notebook = await engine.notebooks.create("Main");
const artifact = await engine.artifacts.create("video", "intro clip");
```

### External APIs
**ALWAYS use `@apicity` providers** — never direct `fetch` to AI/LLM APIs:

All external API calls from the server use `@apicity` provider packages. API keys are stored in `.env` and loaded via `dotenv/config`.

```typescript
import { kimicoding } from "@apicity/kimicoding";
const provider = kimicoding({ apiKey: process.env.KIMI_CODING_API_KEY! });
const response = await provider.chat({ model: "k2p5", messages: [...] });
```

### Job Queue
**ALWAYS enqueue long-running ops** — never run directly in MCP tool handlers:

All long-running or async processes on the server go through the queue singleton from `server/src/queue.ts` for concurrency control, retries, and graceful shutdown. Use `queue.enqueueAndWait()` when the tool needs to return the result, or `queue.enqueue()` for fire-and-forget.

```typescript
import { queue } from "../queue.js";
queue.execute(async (job) => { /* handler */ });
const result = await queue.enqueueAndWait(jobId, payload);
```

### MCP Tool Development
```typescript
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export function registerMyTool(server: McpServer): void {
  server.registerTool(
    "tool_name",
    {
      description: "Description",
      inputSchema: z.object({ param: z.string() }),
    },
    async ({ param }) => ({
      content: [{ type: "text", text: `Result: ${param}` }],
    }),
  );
}
```
Export from `server/src/tools/index.ts`.

## Best Practices

### State Management
- **Local-first**: Start with `useState`/`useReducer` in consuming component
- **Derived state elimination**: Never store computable values. Use `useMemo` for expensive ops, compute inline for trivial ones
- Never duplicate MCP data into separate state
- Lift state only when concrete cross-component need is demonstrated
- Prefer explicit props for three levels or fewer before introducing Context or Zustand
- **Hierarchy**: Props → Context → Zustand (only if Context has perf issues)

### useEffect Minimization
Treat each `useEffect` as technical debt. **No MCP tool calls in effects** — use event handlers or custom hooks.

- Derive values from props during render instead of synchronizing them into state
- Subscriptions and listeners must return cleanup functions
- Reserve effects for genuine side effects such as analytics or imperative DOM operations via refs

### MCP Data Layer
- Single `useMcpConnection()` instance shared via props/Context
- `useMcpConnection()` owns connection lifecycle and invocation through the official v2 client; treat its state as read-only
- Wrap tool invocations in domain-specific custom hooks that encapsulate tool names, argument construction, and result parsing
- **No tool calls in effects** — causes race conditions
- Guard tool calls: `if (state !== "ready") return`

### Component Design
- Custom hooks: data fetching + business logic
- Keep hooks single-purpose with descriptive names (`useSearchTool`, not `useUtils`)
- Components: pure functions of props, render JSX only
- Use `useMemo`/`useCallback` only for expensive computations or functions passed to memoized children
- Avoid inline object/array creation in JSX props
- Use stable `key` props based on unique IDs, not indices

### Testing
- Write **integration tests with real dependencies** (zero mocks)
- Example test pattern: see existing tests in `server/src/tools/*.test.ts`

## Environment Variables

- `PORT` (defaults to 3001)
- `KIMI_CODING_API_KEY`
- `DASHSCOPE_API_KEY`
- Never commit secrets

## Project References

- `tsconfig.app.json` - Client (`src/`)
- `tsconfig.node.json` - Vite config
- `server/tsconfig.json` - Server (`server/src/`)

Always build client before server if both change: `npm run build && npm run build:server`

## Stack

| Category | Library |
|----------|---------|
| Build | Vite 7 |
| UI | React 19 |
| Language | TypeScript 5.9 |
| MCP Client | @modelcontextprotocol/client 2 |
| MCP Server | @modelcontextprotocol/server 2 + @modelcontextprotocol/node 2 |
| Server | Express |
| Validation | Zod |
| Domain/storage | videobook-engine + embedded DoltLite |
| Job Queue | videobook-engine runtime tables |
| Linting | ESLint 9 |
| Testing | Vitest |

<!-- BEGIN BEADS INTEGRATION v:1 profile:full hash:19cc25d9 -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Dolt-powered version control with native sync
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Quality
- Use `--acceptance` and `--design` fields when creating issues
- Use `--validate` to check description completeness

### Lifecycle
- `bd defer <id>` / `bd supersede <id>` for issue management
- `bd stale` / `bd orphans` / `bd lint` for hygiene
- `bd human <id>` to flag for human decisions
- `bd formula list` / `bd mol pour <name>` for structured workflows

### Sync

bd stores issue history in Dolt:

- Each write auto-commits to Dolt history
- Use `bd dolt push`/`bd dolt pull` for remote sync
- Do not treat `.beads/issues.jsonl` as the sync protocol

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

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
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.

<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
