# @apicity bugs, gaps, and quirks that Videocity works around

This document tracks provider-package behavior that Videocity cannot consume
directly. It was re-audited against the installed `@apicity/*@0.8.0` packages on
2026-07-21 after Videocity finished adopting 0.8.0 (cost adapters, derived
schemas, removed obsolete shims). Where Apicity exposes a correct schema or
registry entry, Videocity derives the corresponding enum, range, default, string
length, slot count, model slug, or price instead of re-declaring it.

## Post-0.8.0 release-candidate status

This document was checked again on 2026-07-22 against Apicity `main` at
`1a903a73`. Videocity still installs 0.8.0, so entries marked **FIXED ON APICITY
MAIN** describe the next-release candidate, not code currently available from
npm. Keep the 0.8.0 workarounds until Videocity adopts that release.

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

## 3. (gap) Fal model aliases use output types — FIXED ON APICITY MAIN

Kie, Alibaba, xAI, and the other request-oriented packages now export request
aliases as `z.input<typeof Schema>`, matching `*RequestInput` aliases, and
separate parsed output aliases. Videocity removed the broad assembled-object
assertions that had compensated for output-typed defaults in
`server/src/payload-builders.ts`. Narrow casts remain only at app boundaries
where Videocity intentionally accepts a different local wire shape and converts
it to a provider enum or number.

In 0.8.0, `@apicity/fal` is the exception. Its model aliases are declarations such as
`FalNanoBanana2TextToImageParams = z.infer<typeof
FalNanoBanana2TextToImageRequestSchema>`, so fields with defaults are required in
the alias even though callers may omit them. The generic Fal queue submission
also types `input` as `Record<string, unknown>` rather than associating an
endpoint ID with its request schema.

Apicity `main` changes the request aliases to `z.input`, adds separate parsed
`z.output` aliases, and exports `FalEndpointInputMap` for endpoint-specific queue
input. This closes the upstream ask once the next package release is adopted.

**Workaround:** Videocity derives every Fal-facing tool constraint from the live
request schemas, then assembles the background queue payload as a generic record.

**Release adoption:** replace the generic queue record with
`FalEndpointInputMap` and remove any remaining default-field type compensation.

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

| Tool/field                                           | Videocity                              | Base Apicity schema                                    | Reason                                                                           |
| ---------------------------------------------------- | -------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `generate_grok_imagine_video.mode`                   | `fun`/`normal`                         | includes conditionally valid `spicy`                   | Videocity exposes only the external-image path; see §2                           |
| `generate_grok_imagine_video` with `image_urls`      | omits `index`                          | optional `index` still accepted alongside `image_urls` | Kie docs: `index` is `task_id`-only; see §2                                      |
| `generate_wan27_videoedit_video.duration`            | exact string values `0,2..10`          | numeric schema with an opaque refine                   | the exact values are derived from `Wan27VideoEditDurationValues`                 |
| `generate_grok_imagine_ref_video` duration with refs | max 10 seconds when references present | general video schema allows 1..15 seconds              | reference-specific ten-second cap is not in Apicity; seven-image max is; see §22 |

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

## 11. (bug) Kie media fields require public URLs before upload — FIXED ON APICITY MAIN

Two Kie request schemas type asset fields as `z.string().url()` even though
Videocity (and any SDK consumer that uploads after validation) only has local
`@img-*` / `@vid-*` / `@aud-*` slugs at tool-invoke time.

**Seedance 2 Mini** — 0.8.0 keeps `.url()` deliberately (clearer error message)
and caps images at `.max(9)`:

```ts
reference_image_urls: z.array(urlMsg).max(9).default([]);
reference_video_urls: z.array(z.string().url()).max(3).default([]);
reference_audio_urls: z.array(z.string().url()).max(3).default([]);
```

Regular and Fast Seedance stay on plain strings.

**Qwen2 image-edit** — `image_url` is still `z.string().url()`. Pre-upload
`safeParse` with a bare `@img-*` slug fails with `Invalid URL` (vc-zcxs).

**Workaround:** Mini uses `apicityStringArrayField` + omits refs from the
pre-check; Qwen2 uses `slugAsPlaceholderUrl` for pre-check only. Jobs upload
real CDN URLs before calling Kie.

Apicity `main` accepts plain strings for Seedance 2 Mini reference media and
Qwen2 image-edit media at the construction boundary. Its generated KIE README
also preserves the requirement to replace local asset identifiers with
publicly reachable URLs before `createTask`.

**Release adoption:** remove the Mini pre-check omission and Qwen2 placeholder
URL shim after the next KIE package is installed; retain the upload step itself.

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

## 17. (quirk) Google Flow email requirements are route-specific — CONSUMER REQUIREMENT

0.8.0 documents that voice create/list and character/account path operations
require `email` (no single-account fallback), while generation schemas leave
`email` optional for load-balancing / reference reuse. Videocity still needs a
resolved account for the required-email entity calls.

**Workaround:** `resolveGoogleFlowEmail` uses an explicit email or resolves the
sole account before calling those methods.

The required fields are correct. Unless useapi.net adds a single-account
default to the entity routes, this is a consumer resolution requirement rather
than an Apicity gap.

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

## 25. (gap) ~~Kie OmniHuman and Volcengine models are absent from the cost registry~~ — RESOLVED in 0.8.0 (formal hints fixed on main; §30)

`@apicity/cost@0.8.0` registers slugs (`oh1p5`, `vlipsync`) and per-second rates
for both models. Schemas still omit duration (output follows driving audio /
source video), so callers must pass a top-level duration hint — see §30.

**Workaround:** tools use `modelSlug("kie", …)` for asset/job names; cost
adapters + job handlers pass `KieCostHints` from source audio/video metadata.
`COST_TABLE_PENDING_MODELS` was removed; OTP minting fails closed without a
duration hint.

## 26. (gap) Fal cost coverage is image-only — FIXED ON APICITY MAIN

`EstimateRequest` accepts `provider: "fal"` with endpoint-keyed rates for Nano
Banana family, Seedream v5 Lite text-to-image, flux, and qwen-image. Videocity's
Fal **video** tools (Kling v3, Wan, Seedance, Grok Imagine video) and several
edit endpoints (e.g. Seedream edit, Nano Banana 2 edit) remain unpriced.

**Workaround:** `FAL_ADAPTERS` in `cost-adapters.ts` cover priced image tools
(`generate_nano_banana_*_fal`, `generate_seedream_v5_lite_fal`). Unpriced Fal
tools still show "—".

Apicity `main` adds static rates for the Fal video and remaining edit/image
endpoints used by Videocity, with per-second models reading
`costHints.durationSeconds` when their wire request cannot declare duration.
`google/nano-banana-2-lite` and `google/nano-banana-lite/edit` remain explicitly
listed as dynamic-pricing endpoints rather than receiving guessed static rates.

**Release adoption:** extend `FAL_ADAPTERS` to the newly priced tools; retain
"—" for the two declared dynamic-pricing endpoints.

## 27. (gap) ~~xAI media generation has no per-unit cost contract~~ — RESOLVED in 0.8.0

Per-second video (`grok-imagine-video*`) and per-generation image
(`grok-imagine-image*`) rates are registered. Video units read top-level
`duration` only. Videocity's `getCostAdapter` routes `_provider: "xai"` to
`XAI_ADAPTERS` (docs.x.ai model keys), not Kie `grok-imagine/*` slugs.

## 28. (gap) Alibaba media cost is incomplete for non-pro image — FIXED ON APICITY MAIN

0.8.0 prices `qwen-image-*`, `wan2.7-image-pro`, `wan2.7-i2v`, and
`wan2.7-videoedit`. Non-pro `wan2.7-image` still has no per-image rate.

**Workaround:** `ALIBABA_ADAPTERS` cover Qwen image/edit, Wan image pro, and
Wan i2v video. `generate_alibaba_image` (non-pro) still shows "—" when unpriced.

Apicity `main` registers `wan2.7-image` as `wan2p7` at the International-region
list rate of $0.03/image. The pro rate remains $0.075/image.

**Release adoption:** add the normal Alibaba cost adapter for
`generate_alibaba_image` and remove its unpriced display path.

## 29. (gap) ~~ElevenLabs TTS text limits are model-specific but absent from the schema~~ — RESOLVED in 0.8.0

0.8.0 exports `ELEVENLABS_TEXT_TO_SPEECH_MODEL_TEXT_LIMITS` and enforces
per-model caps (with a default-model path when `model_id` is omitted) plus a
static 40k ceiling. Videocity leaves max validation to the package.

## 30. (gap) Per-second cost extractors need out-of-band duration — FIXED ON APICITY MAIN

`@apicity/cost` prices several Kie models per second while their request schemas
have no duration field (output follows source/driving media):

| Model                                | Duration source |
| ------------------------------------ | --------------- |
| `happyhorse/video-edit`              | source video    |
| `kling-3.0/motion-control`           | motion video    |
| `omnihuman-1-5`                      | driving audio   |
| `volcengine/video-to-video-lip-sync` | source video    |

Without a duration, `computeEstimate` returns an unbounded warning. 0.8.0
documents top-level `duration` as the cost-only convention
(`input.duration ?? p.duration`).

**Workaround:** out-of-band `KieCostHints` in `cost-adapters.ts` / `kie-paygate.ts`:

- job handlers measure source media and pass `costHints: { duration }`;
- `normalizeKieCostPayload` sets top-level `duration` for the estimate only;
- OTP hashes the verbatim wire request (no duration field);
- hints persist in `.generation-cost-hints.json` for queued re-submit;
- `estimate_cost` enriches from asset `original` duration metadata.

Apicity `main` exports `CostHints` and accepts
`costHints: { durationSeconds }` on `EstimateRequest`. KIE, xAI, and Fal
per-second readers use that typed side channel while preserving the verbatim
wire request for paygate hashing. Legacy payload duration readers remain for
compatibility, but the warning now directs consumers to the formal field.

**Release adoption:** map Videocity's measured `KieCostHints.duration` to
`costHints.durationSeconds`, then remove the top-level estimate-only duration
injection. Keep measurement, persistence, and fail-closed behavior.

## 31. (bug) Fal area pricing guesses omitted image sizes — FIXED ON APICITY MAIN

0.8.0 assumes one megapixel per image whenever `image_size` is omitted. That is
unsafe for endpoints without a published fixed default and can underprice a
request after Fal's per-image whole-megapixel rounding.

Apicity `main` uses the documented `landscape_4_3` default for Flux dev, Flux
schnell, and Qwen Image. Qwen Image Edit publishes no fixed default, so omission
now produces an unbounded warning; Hunyuan instruct edit continues to warn for
its upstream `auto` default. Explicit presets are still rounded up per image.

## 32. (bug) Kling 3.0 multi-shot requests can select the wrong sound rate — FIXED ON APICITY MAIN

In 0.8.0, KIE Kling 3.0 selects the sound tier only for explicit
`sound: true`. KIE promotes omitted sound to the sound-enabled behavior when
`multi_shots: true`, so that request shape can be underpriced.

Apicity `main` selects the sound tier for `multi_shots: true` plus omitted
`sound`; explicit `sound: false` continues to use the base tier.

## 33. (gap) ElevenLabs MCP metadata hides the default-model text cap — FIXED ON APICITY MAIN

The 0.8.0 provider schema correctly enforces 10,000 characters when `model_id`
is omitted and a model-specific cap up to 40,000 when it is explicit. Its static
JSON Schema still presents only `maxLength: 40000`, so MCP clients cannot see
the conditional default-model rule.

Apicity `main` adds the conditional rule to the root request-schema description,
and `@apicity/mcp-server` includes that guidance in all four TTS tool
descriptions without weakening the static bound.

## 34. (gap) KIE Nano Banana has a slug but no price — FIXED ON APICITY MAIN

0.8.0 registers KIE `nano-banana` but deliberately leaves it unpriced pending a
public-rate check. Apicity `main` records KIE's published 4-credit rate as
$0.02/image and removes the model from the unpriced allowlist.

## 35. (gap) KIE MiniMax H3 ships without cost slugs or pricing — OPEN in 0.8.6

`@apicity/kie@0.8.6` adds the three MiniMax H3 video endpoints
(`minimax-h3/text-to-video`, `minimax-h3/image-to-video`,
`minimax-h3/reference-to-video`) to `MediaGenerationRequest`, but
`@apicity/cost@0.8.6` knows nothing about them. Two independent failures, both
reproduced against the installed 0.8.6 packages:

1. `modelSlug("kie", "minimax-h3/text-to-video")` throws
   `No slug registered for kie/minimax-h3/text-to-video — add it to
   packages/provider/cost/src/slugs.ts`. Generate-tool modules evaluate
   `modelSlug()` at module scope (`const SLUG = modelSlug(...)`), so an
   unguarded call takes down server startup, not just the one tool.
2. `computeEstimate({ provider: "kie", payload: { model:
   "minimax-h3/text-to-video", input: { duration: 6, resolution: "768P" } } })`
   returns `usd: 0` with warning
   `model 'minimax-h3/text-to-video' not found in pricing table for provider
   'kie'`. `mintKieOtp` (`server/src/jobs/kie-paygate.ts`) throws
   `KIE cost estimate is not bounded` on any warning, so no MiniMax H3 task can
   be submitted at all.

There is no supported way to inject pricing at runtime — `@apicity/cost` exports
`PRICING` and `MODEL_SLUGS` as plain consts, and rewriting the model id inside
`normalizeKieCostPayload` to borrow another model's rate would knowingly
misprice a paid call.

**Workaround (shipped):** `server/src/minimax-h3-cost.ts` holds a local
per-second ceiling table (768P $0.18, 2K $0.26), same shape of local-rate
module as the Gemini API table in `google-flow-cost.ts` (§15). Two properties
keep it honest:

- **It is a ceiling, not Kie's price.** Kie bills video in credits/s and
  publishes no MiniMax H3 credit rate readable without a console login, so the
  table takes the highest public rate found (EmpirioLabs, retrieved
  2026-08-06 — MiniMax list was $0.08/$0.13, Atlas Cloud $0.10/$0.14). The
  estimate is a spend *bound*: over-stating only makes the paygate more
  conservative, and the number never leaves the process — `mintOtp` hashes the
  wire payload, not the estimate. Displayed estimates read high until the real
  rate lands.
- **Upstream reclaims priority automatically.** `mintKieOtp` consults the local
  table only after `computeEstimate` warns, so the package wins the moment it
  ships rates. `minimax-h3-cost.test.ts` asserts `computeEstimate` still warns
  for all three models — that test failing is the signal to delete the module.

A payload with no readable duration still fails closed; the ceiling bounds a
duration it can read rather than papering over a missing one.

**Ask Apicity:** register `minimax-h3/{text,image,reference}-to-video` slugs
and publish per-second (or per-unit) rates for the `duration` × `resolution`
(768P / 2K) tiers.

---

## Open / partial summary (installed 0.8.0 plus Apicity main candidate)

| Status            | Sections                                              | What Videocity still carries                            |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| **OPEN**          | §18 character metadata                                | list/singleton reconcile                                |
| **PARTIAL**       | §35 MiniMax H3 cost coverage                          | local ceiling table (`minimax-h3-cost.ts`); no slug map |
| **PARTIAL**       | §14 Flow loose schemas                                | per-model domains                                       |
| **PARTIAL**       | §15 Flow estimate semantics                           | local Gemini API list USD (`google-flow-cost.ts`)       |
| **PARTIAL**       | §22 xAI 10s ref duration                              | local 10s check; 7-ref max **derived**                  |
| **PARTIAL**       | §23 Seedream residual                                 | `auto_4K`/counts **derived**; no `return_byteplus_urls` |
| **PARTIAL**       | §24 NB edit max                                       | counts/seeds **derived**; local `.max(14)` only         |
| **FIXED ON MAIN** | §3 Fal input/output types                             | adopt `FalEndpointInputMap`                             |
| **FIXED ON MAIN** | §11 pre-upload media strings                          | remove Mini/Qwen2 pre-check shims after upgrade         |
| **FIXED ON MAIN** | §26 Fal static coverage                               | extend adapters; keep dynamic endpoints unpriced        |
| **FIXED ON MAIN** | §28 Alibaba non-pro image                             | add normal adapter after upgrade                        |
| **FIXED ON MAIN** | §30 typed duration hints                              | translate `duration` to `durationSeconds`               |
| **FIXED ON MAIN** | §31–34 estimate/MCP gaps                              | no new workaround; adopt next release                   |
| **RESOLVED**      | §1–2, §4–7, §9–10, §12–13, §16, §19–21, §25, §27, §29 | no local shim (defensive Flow path decode only on §16)  |

**Deliberate product quirks (not Apicity defects):** §2 Grok external-image-only
`spicy` filter, §8 table, §17 route-specific Flow email resolution.

**Deferred upstream verification:** §18 appears service-side; §22 needs a
primary xAI source for the ten-second rule; §23–24 need current Fal docs before
tightening the published contract. §14–15 remain broader Google Flow product
and schema work rather than release blockers for these Apicity fixes.
