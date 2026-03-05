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
| `npm run preview` | Preview production build locally |

**Note:** No test runner is configured. To run tests, you'll need to add a test framework (e.g., vitest) first.

## Architecture

**Frontend** (`src/`): React 19 + TypeScript SPA built with Vite 7.
- Entry: `src/main.tsx` → `src/App.tsx`
- Uses `use-mcp` hook to connect to MCP server at `/mcp`
- Vite proxies `/mcp` to `http://127.0.0.1:3001` in dev mode

**Backend** (`server/src/`): Express-based MCP server.
- Entry: `server/src/index.ts` (Express app on port 3001)
- Server factory: `server/src/server.ts` creates McpServer instances
- Tools: `server/src/tools/*.ts` - register via `server/src/tools/index.ts`

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

## Environment Variables

- Server uses `process.env.PORT` (defaults to 3001)
- No `.env` file is present; add environment variables as needed
- Never commit secrets or API keys to version control

## Project References

Uses TypeScript project references:
- `tsconfig.app.json` - Client source code (`src/`)
- `tsconfig.node.json` - Vite config (`vite.config.ts`)
- `server/tsconfig.json` - Server code (`server/src/`)

Always build client before server if both change: `npm run build && npm run build:server`
