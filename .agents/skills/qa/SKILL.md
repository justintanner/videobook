---
name: qa
description: Run build, lint, tests, and code smell checks against changed code. Use when user types "/qa", "run qa", "check my changes", or "run tests".
allowed-tools: Bash, Grep, Read, Glob
---

# qa

## Context

- Recently changed files: !`git diff --name-only HEAD~1 2>/dev/null`
- Staged files: !`git diff --staged --name-only`
- Unstaged changes: !`git diff --name-only`

## Instructions

Run all steps below and report a summary. Do not fix issues — only report them.

### Step 1: Identify changed files

Collect all changed `.ts` and `.tsx` files from the context above (recently changed, staged, and unstaged) into a single deduplicated list. These drive code smell checks.

### Step 2: Tier 1 — Build & Lint

Run these commands unconditionally:

```bash
npm run build
```

```bash
npm run lint
```

**If `npm run build` fails, the type-check or bundle is broken. Report immediately and stop — do not continue to later steps.**

Record exit code and whether output looks reasonable (no errors).

### Step 3: Tier 2 — Tests

Run vitest:

```bash
npm run test
```

Record pass/fail count and any failure details.

### Step 4: Code smell scan

Scan changed `.ts` and `.tsx` files (exclude `node_modules/`, `dist/`) using Grep for:

- `debugger` — debugger statements
- `console.log` in `server/src/` files — server-side debug logging left in
- Bare `catch {` or `catch (e) {` immediately followed by empty body or just a comment — swallowed errors

Record each finding with file path and line number.

### Step 5: Report summary

Output a summary table:

```
## QA Results

| Check          | Status | Details |
|----------------|--------|---------|
| Build          | ...    | ...     |
| Lint           | ...    | ...     |
| Tests          | ...    | ...     |
| Code smells    | ...    | ...     |
```

Below the table, list every command that was run and its exit code. Then list any issues found with file paths and line numbers.

If all checks pass, end with "All QA checks passed."
