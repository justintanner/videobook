# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — Start Vite dev server with HMR
- `npm run build` — Type-check with `tsc -b` then bundle with Vite
- `npm run lint` — Run ESLint across the project
- `npm run preview` — Preview the production build locally

## Architecture

React 19 + TypeScript + Vite 7 SPA. Entry point is `index.html` → `src/main.tsx` → `src/App.tsx`.

## TypeScript

Strict mode enabled. Uses project references: `tsconfig.app.json` (src code) and `tsconfig.node.json` (Vite/node config). Target ES2022 with bundler module resolution.

## Linting

Flat ESLint config (`eslint.config.js`) with typescript-eslint, react-hooks, and react-refresh plugins. Only lints `*.ts`/`*.tsx` files. `dist/` is ignored.
