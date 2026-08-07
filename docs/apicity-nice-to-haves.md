# @apicity 0.8.8 — executive summary of remaining improvements

**Audience:** whoever owns the `@apicity/*` packages.
**Companion to:** `docs/apicity-gaps.md`, the line-by-line catalog of every
Videocity workaround.

## Current state

Videocity uses `@apicity` as the single source of truth for provider request
contracts and pricing. Tool schemas, model registry, payloads, jobs, and cost
adapters derive enums, ranges, defaults, string lengths, slot counts, slugs, and
rates from the installed packages wherever those contracts are complete.

The **0.8.6/0.8.8** releases closed every remaining ask from the 0.8.0 list:

- formal `costHints.durationSeconds` for duration-less per-second models (§30);
- plain-string pre-upload media fields for Seedance Mini + Qwen2 edit (§11);
- Fal cost for video + remaining edit endpoints (§26);
- Fal `z.input` request aliases + `FalEndpointInputMap` (§3);
- MiniMax H3 slugs + per-second pricing (§35);
- Seedream `auto_4K` as an `image_size` preset + [1,6] count bounds (§23);
- xAI reference-to-video 10s cross-field refine (§22);
- KIE Nano Banana $0.02 rate (§34); landscape_4_3 area defaults (§31); Kling
  3.0 multi_shots sound tier (§32); Alibaba non-pro Wan image rate (§28).

What remains is narrower: Google Flow strictness / estimate semantics, and one
Fal key nit.

## Priority table

| Priority | Ask | Why it matters |
|---|---|---|
| **P1** | Fix the `FalEndpointInputMap` key for Qwen edit | Map carries `fal-ai/qwen-image-edit`; the real endpoint is `fal-ai/qwen-image/edit`, so that one job stays on the untyped fallback |
| **P2** | Google Flow strict per-model request/response schemas | Veo alias hatch narrowed; responses still loose |
| **P2** | Optional Gemini API list-rate USD for Flow (or plan-tier credits) | Package prices credit×Pro; some UIs want API list USD |
| **P2** | Service-side: Flow singleton character reads lose metadata | Singleton returns `Untitled Character` / omits `personalityNotes`; list/create keep them |

## Catalog refs

- Fal input map key: §3
- Google Flow: §14, §15, §17, §18

## Bottom line

Apicity 0.8.8 let Videocity delete its last local rate table and its last
contract patches. The highest-value remaining work is Google Flow schema
strictness and the one Fal endpoint-map key fix.
