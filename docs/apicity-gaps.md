# @apicity bugs, gaps, and quirks that Videocity works around

This document tracks provider-package behavior that Videocity cannot consume
directly. It was re-audited against the installed `@apicity/*@0.8.0` packages on
2026-07-21 after Videocity finished adopting 0.8.0 (cost adapters, derived
schemas, removed obsolete shims). Where Apicity exposes a correct schema or
registry entry, Videocity derives the corresponding enum, range, default, string
length, slot count, model slug, or price instead of re-declaring it.

Legend: **bug** = the published contract is wrong or internally inconsistent;
**gap** = the published contract omits required information; **quirk** = correct
provider behavior that cannot be represented directly in Videocity's field-level
UI schema.

## 1. (quirk) ~~Mixed Zod major versions~~ — RESOLVED in 0.6.1

All installed provider packages use Zod 4. Videocity's readers in
`server/src/zod-slots.ts` therefore inspect only the Zod 4 layout.

## 2. (quirk) Grok image-to-video `spicy` mode is conditional — RESOLVED UPSTREAM

`@apicity/kie` constrains the image-to-video prompt to 4096 characters, removes
`auto` from its aspect ratios, bounds duration to integer seconds from 6 through
30, rejects `spicy` when external `image_urls` are supplied, and requires exactly
one of `image_urls` or `task_id`. `spicy` remains valid for the separate
`task_id` reuse path.

Videocity's `generate_grok_imagine_video` tool only exposes the external-image
path, while its generated form schema is field-level and cannot express that
cross-field condition. It therefore derives the provider's base mode enum and
filters out `spicy`; the payload builder also normalizes stale saved `spicy`
values to `normal`, omits `index` on the `image_urls` path (Kie treats `index` as
`task_id`-only), and rewrites prompt `@img-*` mentions to `@imageN` after
ordering `image_urls` by first prompt mention.

## 3. (gap) Fal model parameter aliases still use output types — OPEN in 0.8.0

Kie, Alibaba, xAI, and the other request-oriented packages now export request
aliases as `z.input<typeof Schema>`, matching `*RequestInput` aliases, and
separate parsed output aliases. Videocity removed the broad assembled-object
assertions that had compensated for output-typed defaults in
`server/src/payload-builders.ts`. Narrow casts remain only at app boundaries
where Videocity intentionally accepts a different local wire shape and converts
it to a provider enum or number.

`@apicity/fal` is the exception. Its model aliases remain declarations such as
`FalNanoBanana2TextToImageParams = z.infer<typeof
FalNanoBanana2TextToImageRequestSchema>`, so fields with defaults are required in
the alias even though callers may omit them. The generic Fal queue submission
also types `input` as `Record<string, unknown>` rather than associating an
endpoint ID with its request schema.

**Workaround:** Videocity derives every Fal-facing tool constraint from the live
request schemas, then assembles the background queue payload as a generic record.

**Ask Apicity:** export `z.input` and `z.output` aliases for every Fal model
schema, and expose an endpoint-to-input type map for queue submission.

## 4. (gap) ~~Alibaba Qwen stable model and slot schemas~~ — RESOLVED in 0.7.3

`@apicity/alibaba` exports:

- `AlibabaQwenImageGenerationImageSlotsSchema` and
  `AlibabaQwenImageEditImageSlotsSchema`;
- `AlibabaQwenImageGenerationStableModelSchema` and
  `AlibabaQwenImageEditStableModelSchema`;
- the shared multimodal parameter schemas.

The Qwen generation/edit tools and image-model registry now derive their model
lists, reference cardinality, parameter ranges, defaults, and string limits from
those exports. No curated stable-model mirror remains.

## 5. (gap) ~~No standalone Alibaba video model enum~~ — RESOLVED

`AlibabaVideoSynthesisModelSchema` exports the exact
`wan2.7-i2v`/`wan2.7-videoedit` domain. The tool, UI registry, job payload, and
payload builder now use that schema/type directly.

## 6. (gap) ~~No exported HappyHorse duration schema~~ — RESOLVED

`@apicity/kie` exports `HappyHorseDurationSchema` for integer durations from 3
through 15 seconds. All three HappyHorse 1.1 generation tools and their generated
form schemas now derive from it.

## 7. (gap) ~~`@apicity/x` had no `users/me` endpoint~~ — RESOLVED in 0.7.0

Videocity uses `x.get.v2.users.me()` through
`server/src/x/authenticated-handle.ts`, retaining its local handle cache only as
an offline fallback.

## 8. (quirk) Deliberate Videocity restrictions that differ from a base schema

| Tool/field | Videocity | Base Apicity schema | Reason |
|---|---|---|---|
| `generate_grok_imagine_video.mode` | `fun`/`normal` | includes conditionally valid `spicy` | Videocity exposes only the external-image path; see §2 |
| `generate_grok_imagine_video` with `image_urls` | omits `index` | optional `index` still accepted alongside `image_urls` | Kie docs: `index` is `task_id`-only; see §2 |
| `generate_wan27_videoedit_video.duration` | exact string values `0,2..10` | numeric schema with an opaque refine | the exact values are derived from `Wan27VideoEditDurationValues` |
| `generate_grok_imagine_ref_video` duration with refs | max 10 seconds when references present | general video schema allows 1..15 seconds | reference-specific ten-second cap is not in Apicity; seven-image max is; see §22 |

These are the only deliberate restrictions represented by
`APICITY_DERIVE_SKIP` or by targeted validation against an otherwise reusable
strict provider schema. Google Flow's broader local contract is tracked in §14.
Fal Wan reference-to-video derives from
`FalWanV2p7ReferenceToVideoRequestSchema`. Pre-upload URL typing workarounds are
tracked in §11; out-of-band cost duration hints are tracked in §30.

## 9. (gap) ~~HappyHorse 1.1 slugs and pricing~~ — RESOLVED in 0.6.1

`@apicity/cost` prices the three `happyhorse-1-1/*` generation endpoints.
Videocity uses their actual model slugs and no longer admits them through a
missing-cost paygate exception.

## 10. (gap) ~~Seedance 2 Mini slug and pricing~~ — RESOLVED in 0.6.1

`@apicity/cost` registers `bytedance/seedance-2-mini` and its 480p/720p
per-second rates. Videocity uses `modelSlug`, a normal cost adapter, and bounded
paygate pricing.

## 11. (bug) Some Kie media fields require public URLs before upload — OPEN in 0.8.0

Two Kie request schemas type asset fields as `z.string().url()` even though
Videocity (and any SDK consumer that uploads after validation) only has local
`@img-*` / `@vid-*` / `@aud-*` slugs at tool-invoke time.

**Seedance 2 Mini** — 0.8.0 keeps `.url()` deliberately (clearer error message)
and caps images at `.max(9)`:

```ts
reference_image_urls: z.array(urlMsg).max(9).default([])
reference_video_urls: z.array(z.string().url()).max(3).default([])
reference_audio_urls: z.array(z.string().url()).max(3).default([])
```

Regular and Fast Seedance stay on plain strings.

**Qwen2 image-edit** — `image_url` is still `z.string().url()`. Pre-upload
`safeParse` with a bare `@img-*` slug fails with `Invalid URL` (vc-zcxs).

**Workaround:** Mini uses `apicityStringArrayField` + omits refs from the
pre-check; Qwen2 uses `slugAsPlaceholderUrl` for pre-check only. Jobs upload
real CDN URLs before calling Kie.

**Ask Apicity:** plain strings at the construction boundary, or a separate
pre-upload reference schema.

## 12. (gap) ~~Gemini Omni slug and pricing~~ — RESOLVED in 0.7.3

`@apicity/cost` registers `gemini-omni-video`, the `geminiomni` model slug, and
T2V/V2V rate rows. Videocity uses `modelSlug` for asset/job names and a normal
cost adapter. String-duration and V2V selector defects from 0.7.3 were fixed in
0.8.0 (see §21); both T2V and V2V mint bounded OTPs without paygate exceptions.

## 13. (gap) ~~No Gemini Omni character-create endpoint~~ — RESOLVED UPSTREAM

`@apicity/kie` exports both `kie.post.api.v1.omni.audio.create` and
`kie.post.api.v1.omni.character.create`, including request/response schemas.
Videocity does not yet expose Kie audio/character ID-minting workflows, so its
Gemini Omni generation tool intentionally omits optional `audio_ids` and
`character_ids`. That is a Videocity product gap, not an Apicity gap.

## 14. (gap) Google Flow schemas still have loose enums and generic responses — PARTIAL in 0.8.0

0.8.0 narrows the Veo model escape hatch to versioned aliases
(`veo-\d+(?:\.\d+)*(?:-[a-z0-9]+)*`) instead of bare `z.string()`. Image/video
model fields and job/entity responses remain largely loose / untyped. Shared
video duration still includes 4/6/8/10 while allowed subsets vary by model.

**Workaround:** per-model domains, positional reference mapping, tolerant
response readers.

**Ask Apicity:** export strict per-model schemas and typed job/entity responses.

## 15. (gap) Google Flow package rates are credit×Pro, not Gemini API list USD — PARTIAL in 0.8.0

`@apicity/cost@0.8.0` accepts `provider: "googleflow"` and prices
`veo-3.1-quality` / `fast` / `lite` / `lite-low-priority` / `omni-flash` as Flow
credits × Pro ($0.02/credit). Videocity badges still use official Gemini
Developer API list rates (720p) with plan credits as secondary metadata in
`server/src/google-flow-cost.ts` (product choice A).

**Workaround:** keep the local estimator for displayed USD; do not route UI
estimates through the package googleflow table without an explicit product
switch to credit-native numbers.

**Ask Apicity:** optionally expose Gemini API list-rate USD alongside Flow
credit estimates, or document plan-tier selection so credit×USD matches Ultra.

## 16. (bug) ~~Google Flow path IDs are percent-encoded~~ — RESOLVED in 0.8.0

`@apicity/googleflow@0.8.0` encodes path segments via `encodePathSegment`, which
restores `:` and `@` after `encodeURIComponent`. Videocity still wires a
defensive `googleFlowFetch` path decode (no-op when the path is already raw) as
belt-and-suspenders for residual over-encoding.

## 17. (gap) Google Flow requires email where generation leaves it optional — OPEN in 0.8.0

0.8.0 documents that voice create/list and character/account path operations
require `email` (no single-account fallback), while generation schemas leave
`email` optional for load-balancing / reference reuse. Videocity still needs a
resolved account for the required-email entity calls.

**Workaround:** `resolveGoogleFlowEmail` uses an explicit email or resolves the
sole account before calling those methods.

**Ask Apicity:** if useapi.net ever supports a single-account default on those
entity routes, make email optional consistently; until then the required fields
are correct and consumers must resolve email themselves.

## 18. (bug) Google Flow singleton character reads lose metadata — OPEN in 0.8.0

Singleton character retrieval can return `Untitled Character` and omit
`personalityNotes` while list/create responses retain them.

**Workaround:** `server/src/tools/google-flow-characters.ts` reconciles singleton
and list records and reports conflicts/partial success.

This may be a useapi.net service bug rather than an SDK bug; confirm upstream.

## 19. (bug) ~~ElevenLabs Sound Generation omits the 450-character cap~~ — RESOLVED in 0.8.0

`ElevenLabsSoundGenerationRequestSchema.shape.text` now has `.max(450)`.
Videocity sets `MAX_SOUND_GENERATION_PROMPT_CHARS` from
`shape.text.maxLength` (no hard-coded 450).

## 20. (bug) ~~xAI Responses search contract is stale~~ — RESOLVED in 0.8.0

`search_parameters` is retired with an explicit error pointing at Agent Tools
`tools: [{ type: "web_search" }]`. Videocity already uses that path in
`verify_x_mentions`.

## 21. (bug) ~~Gemini Omni cost selectors cannot price the published request shape correctly~~ — RESOLVED in 0.8.0

`@apicity/cost@0.8.0` coerces string durations and publishes V2V keys as
`v2v|N` (no trailing empty resolution). Videocity removed the duration
normalization and V2V paygate exception; T2V and V2V both mint bounded OTPs.

## 22. (gap) xAI reference-video duration cap still absent — PARTIAL in 0.8.0

`reference_images` / `reference_image_file_ids` now have `.max(7)` (sourced from
WaveSpeedAI docs). The general video schema still allows 1–15 seconds with no
cross-field refine for a reference-specific ten-second limit. Apicity 0.8.0
explicitly dropped that duration clause (REQ-011).

**Workaround:** `generate_grok_imagine_ref_video` derives the seven-slot max from
`XaiVideoGenerateRequestSchema.shape.reference_images` via
`apicityStringArrayField`. Videocity still rejects durations over ten only when
references are present (local policy in the tool handler and form validation).

**Ask Apicity:** add a cross-field refinement for the ten-second reference limit
if/when xAI documents it on the primary docs.

## 23. (bug) Fal Seedream 5 Lite input schema still incomplete — PARTIAL in 0.8.0

0.8.0 adds `auto_4K` as a **boolean** field (not an `image_size` enum value) and
types `num_images`/`max_images` as `.int().min(1)` with no documented upper
bound. `FalSeedreamV5LiteImageSizeSchema` still stops at `auto_3K`.
`return_byteplus_urls` remains absent.

**Workaround:** Seedream fal tools use `apicityField` for `image_size`,
`auto_4K` (boolean), `num_images`, and `max_images` — no local `"auto_4K"` size
enum patch.

**Ask Apicity:** confirm whether Fal's `auto_4K` is boolean vs size enum, add
`return_byteplus_urls` if still live, and document any count upper bound.

## 24. (bug) Fal Nano Banana edit reference caps still missing — PARTIAL in 0.8.0

`num_images` is now `.int().min(1).max(4)` and `seed` is `.int()` for Nano
Banana 2 / Pro (and original Nano Banana seed is `.int()`). Edit `image_urls`
arrays remain unbounded (0.8.0 dropped an uncited `.max(9)` rather than adding
Fal's 14-reference cap).

**Workaround:** Fal tools derive `num_images` and `seed` with `apicityField`.
Nano Banana 2 / Pro **edit** tools still append a local `.max(14)` on
`image_slugs` after `apicityStringArrayField` (the only remaining local contract
patch for this family).

**Ask Apicity:** add `.max(14)` (or the current Fal doc bound) on Nano Banana
2/Pro edit image arrays.

## 25. (gap) ~~Kie OmniHuman and Volcengine models are absent from the cost registry~~ — RESOLVED in 0.8.0 (duration hints remain §30)

`@apicity/cost@0.8.0` registers slugs (`oh1p5`, `vlipsync`) and per-second rates
for both models. Schemas still omit duration (output follows driving audio /
source video), so callers must pass a top-level duration hint — see §30.

**Workaround:** tools use `modelSlug("kie", …)` for asset/job names; cost
adapters + job handlers pass `KieCostHints` from source audio/video metadata.
`COST_TABLE_PENDING_MODELS` was removed; OTP minting fails closed without a
duration hint.

## 26. (gap) Fal cost coverage is image-only — PARTIAL in 0.8.0

`EstimateRequest` accepts `provider: "fal"` with endpoint-keyed rates for Nano
Banana family, Seedream v5 Lite text-to-image, flux, and qwen-image. Videocity's
Fal **video** tools (Kling v3, Wan, Seedance, Grok Imagine video) and several
edit endpoints (e.g. Seedream edit, Nano Banana 2 edit) remain unpriced.

**Workaround:** `FAL_ADAPTERS` in `cost-adapters.ts` cover priced image tools
(`generate_nano_banana_*_fal`, `generate_seedream_v5_lite_fal`). Unpriced Fal
tools still show "—".

**Ask Apicity:** add rates for Fal video and remaining edit endpoints used by
consumers, or document a dynamic pricing path.

## 27. (gap) ~~xAI media generation has no per-unit cost contract~~ — RESOLVED in 0.8.0

Per-second video (`grok-imagine-video*`) and per-generation image
(`grok-imagine-image*`) rates are registered. Video units read top-level
`duration` only. Videocity's `getCostAdapter` routes `_provider: "xai"` to
`XAI_ADAPTERS` (docs.x.ai model keys), not Kie `grok-imagine/*` slugs.

## 28. (gap) Alibaba media cost is incomplete for non-pro image — PARTIAL in 0.8.0

0.8.0 prices `qwen-image-*`, `wan2.7-image-pro`, `wan2.7-i2v`, and
`wan2.7-videoedit`. Non-pro `wan2.7-image` still has no per-image rate.

**Workaround:** `ALIBABA_ADAPTERS` cover Qwen image/edit, Wan image pro, and
Wan i2v video. `generate_alibaba_image` (non-pro) still shows "—" when unpriced.

## 29. (gap) ~~ElevenLabs TTS text limits are model-specific but absent from the schema~~ — RESOLVED in 0.8.0

0.8.0 exports `ELEVENLABS_TEXT_TO_SPEECH_MODEL_TEXT_LIMITS` and enforces
per-model caps (with a default-model path when `model_id` is omitted) plus a
static 40k ceiling. Videocity leaves max validation to the package.

## 30. (gap) Per-second Kie cost extractors need a duration the wire schema omits — OPEN in 0.8.0

`@apicity/cost` prices several Kie models per second while their request schemas
have no duration field (output follows source/driving media):

| Model | Duration source |
|---|---|
| `happyhorse/video-edit` | source video |
| `kling-3.0/motion-control` | motion video |
| `omnihuman-1-5` | driving audio |
| `volcengine/video-to-video-lip-sync` | source video |

Without a duration, `computeEstimate` returns an unbounded warning. 0.8.0
documents top-level `duration` as the cost-only convention
(`input.duration ?? p.duration`).

**Workaround:** out-of-band `KieCostHints` in `cost-adapters.ts` / `kie-paygate.ts`:

- job handlers measure source media and pass `costHints: { duration }`;
- `normalizeKieCostPayload` sets top-level `duration` for the estimate only;
- OTP hashes the verbatim wire request (no duration field);
- hints persist in `.generation-cost-hints.json` for queued re-submit;
- `estimate_cost` enriches from asset `original` duration metadata.

**Ask Apicity:** formalize a cost-only unit channel (or documented
`EstimateRequest` side field) so every consumer does not reimplement hints.

---

## Open / partial summary (0.8.0, post-Videocity adoption)

| Status | Sections | What Videocity still carries |
|---|---|---|
| **OPEN** | §3 Fal `z.infer` Params | generic Fal queue payloads |
| **OPEN** | §11 pre-upload `.url()` | Mini omit-refs + Qwen2 `slugAsPlaceholderUrl` |
| **OPEN** | §17 Flow email | `resolveGoogleFlowEmail` |
| **OPEN** | §18 character metadata | list/singleton reconcile |
| **OPEN** | §30 duration hints | `KieCostHints` for 4 duration-less models |
| **PARTIAL** | §14 Flow loose schemas | per-model domains |
| **PARTIAL** | §15 Flow estimate semantics | local Gemini API list USD (`google-flow-cost.ts`) |
| **PARTIAL** | §22 xAI 10s ref duration | local 10s check; 7-ref max **derived** |
| **PARTIAL** | §23 Seedream residual | `auto_4K`/counts **derived**; no `return_byteplus_urls` |
| **PARTIAL** | §24 NB edit max | counts/seeds **derived**; local `.max(14)` only |
| **PARTIAL** | §26 Fal video cost | image `FAL_ADAPTERS` only |
| **PARTIAL** | §28 Alibaba non-pro image | adapters for priced models only |
| **RESOLVED** | §1–2, §4–7, §9–10, §12–13, §16, §19–21, §25, §27, §29 | no local shim (defensive Flow path decode only on §16) |

**Deliberate product quirks (not Apicity defects):** §2 Grok external-image-only
`spicy` filter, §8 table.
