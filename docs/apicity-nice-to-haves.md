# @apicity 0.8.0 — executive summary of remaining improvements

**Audience:** whoever owns the `@apicity/*` packages.
**Companion to:** `docs/apicity-gaps.md`, the line-by-line catalog of every
Videocity workaround.

## Current state

Videocity uses `@apicity` as the single source of truth for provider request
contracts and pricing. Tool schemas, model registry, payloads, jobs, and cost
adapters derive enums, ranges, defaults, string lengths, slot counts, slugs, and
rates from the installed packages wherever those contracts are complete.

The **0.8.0** release closed most of the 0.7.3 P0/P1 cost and schema asks:

- Gemini Omni cost string duration + V2V selectors;
- Google Flow path-ID encoding (`:` / `@` preserved);
- ElevenLabs sound-gen 450 cap + TTS model text limits;
- xAI retired `search_parameters`; reference arrays `.max(7)`;
- Fal Nano Banana count/seed ints; Seedream `auto_4K` boolean + int counts;
- cost: OmniHuman, Volcengine, Fal images, xAI media, Alibaba media rates;
- cost: `provider: "fal" | "googleflow"` on `EstimateRequest`.

What remains is narrower: pre-upload URL typing, incomplete Fal video cost,
duration-hint convention for duration-less per-second models, and Google Flow
strictness / estimate semantics.

## Priority table

| Priority | Ask | Why it matters |
|---|---|---|
| **P0** | Formalize cost-only duration for duration-less per-second models | happyhorse/video-edit, motion-control, omnihuman, volcengine all need out-of-band duration; every consumer reinvents hints |
| **P1** | Plain-string pre-upload media fields (or pre-upload schemas) | Seedance Mini + Qwen2 image-edit still `.url()` before local assets are uploaded |
| **P1** | Complete Fal cost for video + remaining edit endpoints | Image endpoints price; Kling/Wan/Seedance/Grok fal video stay "—" |
| **P1** | Export Fal `z.input` Params + endpoint/input map | Still `z.infer` / generic queue input |
| **P2** | Google Flow strict per-model request/response schemas | Veo alias hatch narrowed; responses still loose |
| **P2** | Optional Gemini API list-rate USD for Flow (or plan-tier credits) | Package prices credit×Pro; some UIs want API list USD |
| **P2** | Seedream `return_byteplus_urls` + documented count max; Nano Banana edit `.max(14)` | Residual Fal contract gaps |
| **P2** | xAI reference-to-video 10s cross-field refine | Seven-image max landed; duration cap still local |

## Catalog refs

- Duration hints: §30  
- Pre-upload URLs: §11  
- Fal cost / Params: §3, §26  
- Google Flow: §14, §15, §17  
- Seedream / Nano Banana residual: §23, §24  
- xAI ref duration: §22  

## Bottom line

Apicity 0.8.0 removed most of the remaining cost and constraint workarounds.
The highest-value next release would formalize duration-less per-second costing,
finish Fal video pricing + input aliases, and loosen pre-upload media fields so
SDK consumers can validate before CDN upload.
