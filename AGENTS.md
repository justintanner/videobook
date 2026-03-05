# AGENTS.md

Guidance for AI coding agents working in the Clipfirst repository.

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server + MCP server concurrently |
| `npm run dev:client` | Start Vite dev server only (port 5173) |
| `npm run dev:server` | Start MCP server only (tsx watch, port 3001) |
| `npm run build` | Type-check with tsc -b, then Vite build |
| `npm run build:server` | Compile server TypeScript to server/dist/ |
| `npm run lint` | Run ESLint across all *.ts/*.tsx files |
| `npm run test` | Run vitest integration tests |
| `npm run test:watch` | Run vitest in watch mode |
| `npm run preview` | Preview production build locally |

## Architecture

**Frontend** (`src/`): React 19 + TypeScript SPA built with Vite 7.
- Entry: `src/main.tsx` → `src/App.tsx`
- Uses `use-mcp` hook to connect to MCP server at `/mcp`
- Vite proxies `/mcp` to `http://127.0.0.1:3001` in dev mode

**Backend** (`server/src/`): Express-based MCP server.
- Entry: `server/src/index.ts` (Express app on port 3001)
- Server factory: `server/src/server.ts` creates McpServer instances
- Tools: `server/src/tools/*.ts` - register via `server/src/tools/index.ts`

**Filesystem Layer** (`clipfirst-fs`): Local dependency at `../clipfirst-fs`.
- Provides project/asset management with git versioning
- Entry: `createFs({ outputDir })` returns a `ClipfirstFs` instance
- All project, asset, and file operations MUST go through this package — never use `node:fs` directly for these

## Code Style

### TypeScript Configuration
- **Strict mode enabled** - all strict compiler flags on
- **Target:** ES2022 (client), ES2023 (Vite config)
- **Module:** ESNext with bundler resolution
- **erasableSyntaxOnly:** true - use `type` imports explicitly
- **verbatimModuleSyntax:** true - no `import type { ... }` auto-conversion

### Imports & Exports
- Always use explicit `type` keyword for type imports: `import type { Foo } from './foo'`
- Prefer named exports for functions/hooks: `export function useHook()`
- Use `.js` extensions in imports within server code (Node16 resolution)

### Naming Conventions
- **Components:** PascalCase (e.g., `McpStatus.tsx`)
- **Hooks:** camelCase prefixed with `use` (e.g., `useMcpConnection.ts`)
- **Functions:** camelCase, descriptive verbs (e.g., `registerHelloTool`)
- **Types/Interfaces:** PascalCase (e.g., `McpServer`)
- **Files:** Match the default export name

### Formatting Differences (Client vs Server)

**Client (`src/`):**
- Single quotes for strings
- No semicolons
- 2-space indentation

**Server (`server/src/`):**
- Double quotes for strings
- Semicolons required
- 2-space indentation

### Error Handling
- Prefer returning error states from hooks (e.g., `{ error, retry }`)
- Use early returns for guard clauses
- MCP tools should return structured error responses via the protocol

### React Patterns
- Use functional components with hooks
- Wrap app in `StrictMode` in development
- Destructure props/hook results for clarity
- Inline styles are acceptable for simple components

### Linting
- ESLint flat config (`eslint.config.js`)
- Plugins: typescript-eslint, react-hooks, react-refresh
- Ignores: `dist/` directories
- Only lints `*.ts` and `*.tsx` files

## MCP Tool Development

Tools are registered in `server/src/tools/`:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerMyTool(server: McpServer): void {
  server.tool(
    "tool_name",
    "Description of what the tool does",
    { param: z.string().describe("Parameter description") },
    async ({ param }) => ({
      content: [{ type: "text", text: `Result: ${param}` }],
    })
  );
}
```

Export from `server/src/tools/index.ts` and call in `registerAllTools()`.

## Filesystem Operations

**IMPORTANT:** All project, asset, and file operations MUST use the `clipfirst-fs` package. Never use `node:fs` directly for managing projects, assets, or their files — always go through `createFs()` from `clipfirst-fs`. This ensures git versioning, proper directory structure, and consistent error handling via `Result` types.

Example:
```typescript
import { createFs } from "clipfirst-fs";

const fs = createFs({ outputDir: "/path/to/output" });
const project = await fs.createProject("my-project");
const asset = await fs.createAsset("vid", "intro clip", "my-project");
await fs.writeFile(asset.value.assetId, "original.mp4", buffer, "my-project");
```

## External API Calls

**IMPORTANT:** All external API calls from the server MUST use `@nakedapi` provider packages. Never call third-party AI/LLM APIs directly with `fetch` or other HTTP clients — always go through the corresponding `@nakedapi` provider (e.g., `kimicoding()` from `@nakedapi/kimicoding`).

Example:
```typescript
import { kimicoding } from "@nakedapi/kimicoding";

const provider = kimicoding({ apiKey: process.env.KIMI_CODING_API_KEY! });
const response = await provider.chat({
  model: "k2p5",
  messages: [{ role: "user", content: "hello" }],
});
```

## Job Queue

**IMPORTANT:** All long-running or async processes on the server MUST be submitted to the job queue. Never run long-running operations directly in MCP tool handlers — always enqueue them via the `queue` singleton from `server/src/queue.ts`.

- Queue singleton: `server/src/queue.ts` — `import { queue } from "../queue.js"`
- Uses `@platformatic/job-queue` with `MemoryStorage`
- Started in `server/src/index.ts` before Express listens
- `queue.enqueueAndWait(id, payload)` — when the tool needs the result
- `queue.enqueue(id, payload)` — fire-and-forget
- `queue.execute(handler)` — register a job handler

Example:
```typescript
import { queue } from "../queue.js";

// Register handler (once, at startup)
queue.execute(async (job) => {
  // long-running work
  return result;
});

// In a tool handler
const result = await queue.enqueueAndWait(jobId, payload);
```

## Environment Variables

- Server uses `process.env.PORT` (defaults to 3001)
- `.env` file in project root, loaded via `import "dotenv/config"` in server entry points
- API keys: `KIMI_CODING_API_KEY` (KimiCoding)
- Never commit secrets or API keys to version control

## Project References

Uses TypeScript project references:
- `tsconfig.app.json` - Client source code (`src/`)
- `tsconfig.node.json` - Vite config (`vite.config.ts`)
- `server/tsconfig.json` - Server code (`server/src/`)

Always build client before server if both change: `npm run build && npm run build:server`

## Best Practices

### State Management

**Local-first state design.** State starts as `useState` or `useReducer` in the component that consumes it. Lift only when a concrete cross-component sharing need is demonstrated. For shallow hierarchies (3 levels or fewer), prop drilling is preferred over Context or global stores.

**Derived state elimination.** Never store values that can be computed from other state or props. Use `useMemo` for expensive computations or compute inline for trivial transformations. This eliminates synchronization bugs where derived values become stale.

```typescript
// WRONG: derived state stored separately
const [tools, setTools] = useState<Tool[]>([]);
const [filtered, setFiltered] = useState<Tool[]>([]);
useEffect(() => {
  setFiltered(tools.filter(t => t.name.includes(search)));
}, [tools, search]);

// RIGHT: derive during render
const { tools } = useMcpConnection();
const filtered = useMemo(
  () => tools.filter(t => t.name.includes(search)),
  [tools, search]
);
```

**State ownership clarity.** MCP connection state (`state`, `tools`, `error`) is owned by `use-mcp` and is read-only. Local UI state (search filters, selected items, form inputs) is owned by the consuming component. Never duplicate MCP data into separate state variables.

**Shared state hierarchy** (in order of preference):
1. Props — explicit, traceable, testable
2. Context — for infrequently-changing data (theme, auth, MCP connection)
3. Zustand — only when Context causes measurable performance problems

### useEffect Minimization

Treat each `useEffect` as technical debt requiring justification. Most usage has superior alternatives:

| Common Misuse | Better Alternative |
|---|---|
| MCP tool calls in `useEffect` | Event handlers or explicit invocation hooks |
| State synchronization from props | Direct derivation during render |
| User-initiated actions in effects | Event handlers |
| Subscriptions without cleanup | `useSyncExternalStore` or library-managed hooks |

**No tool calls in effects.** MCP tools should be invoked from event handlers or dedicated action hooks, never automatically in `useEffect`. Effects cause race conditions, double invocation in Strict Mode, and lack cancellation.

**Always clean up.** Effects establishing WebSocket connections, event listeners, or subscriptions must return cleanup functions.

### MCP Data Layer

**Connection management.** `useMcpConnection()` wraps `use-mcp` with project defaults and is the single source of truth for MCP connection state. Never create parallel connection instances. Share via props or Context when multiple components need access.

**Tool invocation.** Prefer explicit invocation over effect-based calling:

```typescript
// WRONG: calling tools in effects
useEffect(() => {
  if (state === "ready") callTool("fetch_data", { query });
}, [state, query, callTool]);

// RIGHT: explicit invocation from event handlers
function handleSearch(query: string) {
  if (state !== "ready") return;
  callTool("search", { query }).then(setResults);
}
```

**Custom tool hooks.** Wrap tool invocations in domain-specific hooks that encapsulate tool names, argument construction, result parsing, and loading/error states:

```typescript
function useSearchTool() {
  const { callTool, state } = useMcpConnection();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async (query: string) => {
    if (state !== "ready") return;
    setLoading(true);
    setError(null);
    try {
      const response = await callTool("search", { query });
      setResults(parseSearchResults(response));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [callTool, state]);

  return { results, loading, error, search };
}
```

**Server-side tool errors.** Tools return errors as content rather than throwing, so MCP clients receive actionable messages:

```typescript
server.tool("risky_op", "...", schema, async (args) => {
  try {
    const result = await performOperation(args);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : "Unknown"}` }],
      isError: true,
    };
  }
});
```

**Zod for validation.** Zod is a peer dependency of `@modelcontextprotocol/sdk` and the standard for MCP tool input schemas. Use it on the server for all tool inputs and on the client for external data boundaries. The SDK converts Zod schemas to JSON Schema for the wire protocol automatically.

### Component Design

**Separation of concerns.** Extract data fetching and business logic into custom hooks. Components receive data via props and render JSX:

| Layer | Responsibility | Example |
|---|---|---|
| Custom hooks | MCP tool invocation, business logic, state | `useSearchTool`, `useGreeting` |
| Components | Receive data via props, render JSX | Pure functions of props |

**Single-purpose hooks** with descriptive names (`useSearchTool`, not `useUtils`). Compose hooks rather than building monolithic ones.

**Memoization discipline:**

| Primitive | Use When | Avoid When |
|---|---|---|
| `useMemo` | Expensive computations, large list filtering | Trivial operations |
| `useCallback` | Functions passed to memoized children | Functions used only in local event handlers |
| `React.memo` | Pure components with stable props, frequent parent re-renders | Components with frequently changing props |

**Render optimization:**
- Avoid inline object/array creation in JSX props (breaks memoization)
- Use stable `key` props (unique IDs, not array indices)
- Code-split with `React.lazy` and dynamic imports for large feature areas

### Anti-Patterns

**State mistakes:**

| Anti-Pattern | Correct Approach |
|---|---|
| Storing derived data in state | Compute during render with `useMemo` |
| Lifting state prematurely | Local-first; lift only on demonstrated need |
| Context for frequently-updating data | Zustand or component-local state |
| Duplicating MCP connection state | Single `useMcpConnection` hook shared via props/Context |

**Effect mistakes:**

| Anti-Pattern | Correct Approach |
|---|---|
| MCP tool calls in `useEffect` | Event handlers or explicit invocation hooks |
| Missing dependency arrays | Enable `eslint-plugin-react-hooks` exhaustive-deps |
| No cleanup for subscriptions | Cleanup functions, `useSyncExternalStore` |
| Syncing state from props via effect | Derive directly during render |

**MCP mistakes:**

| Anti-Pattern | Correct Approach |
|---|---|
| Hardcoding tool names across components | Encapsulate in custom hooks |
| Ignoring connection state before tool calls | Guard with `state === "ready"` |
| Throwing errors in tool handlers | Return `{ isError: true, content: [...] }` |
| Creating multiple MCP connections | Single connection instance shared via hook |

### Library Selection

Current stack:

| Category | Library | Notes |
|---|---|---|
| Build | Vite 7 | Dev server + Rollup production builds |
| UI | React 19 | StrictMode enabled |
| Language | TypeScript 5.9 | Strict mode, ES2022 target |
| MCP client | use-mcp | Connection, discovery, tool invocation |
| MCP server | @modelcontextprotocol/sdk | McpServer + StreamableHTTPServerTransport |
| Server | Express | HTTP layer for MCP transport |
| Validation | Zod | Shared between server tools and client |
| Filesystem | clipfirst-fs | Project/asset management with git versioning |
| Job Queue | @platformatic/job-queue | In-memory queue with concurrency control |
| Linting | ESLint 9 | Flat config with typescript-eslint, react-hooks |
| Testing | Vitest | Integration tests with real dependencies |

Recommended additions (add only when needed):

| Category | Library | When |
|---|---|---|
| UI Testing | React Testing Library | When adding component tests |
| Complex forms | React Hook Form + Zod resolver | Multi-step or validated forms |
| Global state | Zustand | When Context causes measurable perf issues |
| Routing | React Router v7 or TanStack Router | When the app needs multiple pages |
| Formatting | Prettier | For team-wide code style consistency |
