# AGENTS.md

Guidance for AI coding agents working in the Clipfirst repository.

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

### Running a Single Test
- `npx vitest run server/src/tools/create-project.test.ts`
- `npm run test -- server/src/tools/create-project.test.ts`
- `npx vitest run -t "creates a project"` (by test name)

## Architecture

- **Frontend (`src/`)**: React 19 + TypeScript + Vite 7 SPA. Entry: `main.tsx` → `App.tsx`. Uses `use-mcp` to connect to MCP server at `/mcp`.
- **Backend (`server/src/`)**: Express MCP server on port 3001. Entry: `server/src/index.ts`. Tools in `server/src/tools/*.ts` registered via `server/src/tools/index.ts`.
- **Filesystem (`vc-engine`)**: Local dep at `../vc-engine`. All project/asset ops MUST use `createFs()` — never `node:fs` directly.

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
- MCP tools return structured errors: `{ isError: true, content: [{ type: "text", text: "..." }] }`

### Linting
- ESLint 9 flat config with typescript-eslint, react-hooks, react-refresh
- Ignores: `dist/` directories
- Only lints `*.ts` and `*.tsx` files

**IMPORTANT:** DO NOT ADD COMMENTS unless asked. Never log or commit secrets.

## Key Rules

### Filesystem Operations
**ALWAYS use `vc-engine`** — never `node:fs` for projects/assets:
```typescript
import { createFs } from "vc-engine";
const fs = createFs({ projectsDir: "/path/to/projects" });
const project = await fs.createProject("my-project");
const asset = await fs.createAsset("vid", "intro clip", "my-project");
```

### External APIs
**ALWAYS use `@apicity` providers** — never direct `fetch` to AI/LLM APIs:
```typescript
import { kimicoding } from "@apicity/kimicoding";
const provider = kimicoding({ apiKey: process.env.KIMI_CODING_API_KEY! });
const response = await provider.chat({ model: "k2p5", messages: [...] });
```

### Job Queue
**ALWAYS enqueue long-running ops** — never run directly in MCP tool handlers:
```typescript
import { queue } from "../queue.js";
queue.execute(async (job) => { /* handler */ });
const result = await queue.enqueueAndWait(jobId, payload);
```

### MCP Tool Development
```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerMyTool(server: McpServer): void {
  server.tool("tool_name", "Description", { param: z.string() },
    async ({ param }) => ({
      content: [{ type: "text", text: `Result: ${param}` }],
    })
  );
}
```
Export from `server/src/tools/index.ts`.

## Best Practices

### State Management
- **Local-first**: Start with `useState`/`useReducer` in consuming component
- **Derived state elimination**: Never store computable values. Use `useMemo` for expensive ops, compute inline for trivial ones
- Lift state only when concrete cross-component need is demonstrated
- **Hierarchy**: Props → Context → Zustand (only if Context has perf issues)

### useEffect Minimization
Treat each `useEffect` as technical debt. **No MCP tool calls in effects** — use event handlers or custom hooks.

### MCP Data Layer
- Single `useMcpConnection()` instance shared via props/Context
- **No tool calls in effects** — causes race conditions
- Guard tool calls: `if (state !== "ready") return`

### Component Design
- Custom hooks: data fetching + business logic
- Components: pure functions of props, render JSX only
- Avoid inline object/array creation in JSX props

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
| MCP Client | use-mcp |
| MCP Server | @modelcontextprotocol/sdk |
| Server | Express |
| Validation | Zod |
| Filesystem | vc-engine |
| Job Queue | @platformatic/job-queue |
| Linting | ESLint 9 |
| Testing | Vitest |
