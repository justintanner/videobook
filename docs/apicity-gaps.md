# @apicity bugs, gaps, and quirks that Videocity works around

This document tracks provider-package behavior that Videocity cannot consume
directly. It was re-audited against the installed `@apicity/*@0.7.3` packages on
2026-07-20. Where Apicity exposes a correct schema or registry entry, Videocity
derives the corresponding enum, range, default, string length, slot count, model
slug, or price instead of re-declaring it.

Legend: **bug** = the published contract is wrong or internally inconsistent;
**gap** = the published contract omits required information; **quirk** = correct
provider behavior that cannot be represented directly in Videocity's field-level
UI schema.

## 1. (quirk) ~~Mixed Zod major versions~~ — RESOLVED in 0.6.1

All installed provider packages use Zod 4. Videocity's readers in
`server/src/zod-slots.ts` therefore inspect only the Zod 4 layout.

## 2. (quirk) Grok image-to-video `spicy` mode is conditional — RESOLVED UPSTREAM

`@apicity/kie@0.7.3` now constrains the image-to-video prompt to 4096 characters,
removes `auto` from its aspect ratios, bounds duration to integer seconds from 6
through 30, and rejects `spicy` when external `image_urls` are supplied. `spicy`
remains valid for the separate `task_id` reuse path.

Videocity's `generate_grok_imagine_video` tool only exposes the external-image
path, while its generated form schema is field-level and cannot express that
cross-field condition. It therefore derives the provider's base mode enum and
filters out `spicy`; the payload builder also normalizes stale saved `spicy`
values to `normal`.

## 3. (gap) Fal model parameter aliases still use output types — OPEN in 0.7.3

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
| `generate_wan27_videoedit_video.duration` | exact string values `0,2..10` | numeric schema with an opaque refine | the exact values are derived from `Wan27VideoEditDurationValues` |
| `generate_grok_imagine_ref_video` reference limits | max 7 images; max 10 seconds with references | general video schema allows 1..15 seconds and leaves references unbounded | xAI documents stricter reference-to-video limits; see §22 |

These are the only deliberate restrictions represented by
`APICITY_DERIVE_SKIP` or by targeted validation against an otherwise reusable
strict provider schema. Google Flow's broader local contract is tracked in §14.
Fal Wan reference-to-video now derives from
`FalWanV2p7ReferenceToVideoRequestSchema`; Wan Video Edit's value list itself
is no longer hardcoded.

## 9. (gap) ~~HappyHorse 1.1 slugs and pricing~~ — RESOLVED in 0.6.1

`@apicity/cost` prices the three `happyhorse-1-1/*` generation endpoints.
Videocity uses their actual model slugs and no longer admits them through a
missing-cost paygate exception.

## 10. (gap) ~~Seedance 2 Mini slug and pricing~~ — RESOLVED in 0.6.1

`@apicity/cost` registers `bytedance/seedance-2-mini` and its 480p/720p
per-second rates. Videocity uses `modelSlug`, a normal cost adapter, and bounded
paygate pricing.

## 11. (bug) Seedance 2 Mini reference arrays require public URLs — OPEN in 0.7.3

`Seedance2MiniInputSchema` still declares all three pre-upload reference arrays
with `z.string().url()`:

```ts
reference_image_urls: z.array(z.string().url()).default([])
reference_video_urls: z.array(z.string().url()).max(3).default([])
reference_audio_urls: z.array(z.string().url()).max(3).default([])
```

The regular and Fast schemas use plain strings. Videocity validates local
`@asset` and `@plan/file` references before its job uploads them, so Mini's URL
checks reject valid local inputs too early.

**Workaround:** `generate-seedance2-mini-video.ts` uses
`apicityStringArrayField` to copy each upstream array's cardinality while
intentionally rebuilding its item type as a local string. The full Apicity
pre-check omits the reference arrays; asset resolution validates them locally,
and the submitted job payload contains real uploaded URLs.

**Ask Apicity:** use plain strings at the SDK construction boundary, or export a
separate pre-upload reference schema.

## 12. (gap) ~~Gemini Omni slug and pricing~~ — RESOLVED in 0.7.3

`@apicity/cost@0.7.3` registers `gemini-omni-video`, the `geminiomni` model slug,
and T2V/V2V rate rows. Videocity now uses `modelSlug` for asset/job names and a
normal cost adapter. T2V estimates are bounded after normalizing the Kie
request's string duration to the numeric shape expected by the cost selector.
The remaining V2V selector defect is tracked in §21.

## 13. (gap) ~~No Gemini Omni character-create endpoint~~ — RESOLVED UPSTREAM

`@apicity/kie@0.7.3` exports both
`kie.post.api.v1.omni.audio.create` and
`kie.post.api.v1.omni.character.create`, including request/response schemas.
Videocity does not yet expose Kie audio/character ID-minting workflows, so its
Gemini Omni generation tool intentionally omits optional `audio_ids` and
`character_ids`. That is now a Videocity product gap, not an Apicity gap.

## 14. (gap) Google Flow schemas have loose enums and generic responses — OPEN in 0.7.3

`@apicity/googleflow` correctly types positional reference fields and several
numeric bounds, but video/image model fields still use loose
`z.enum(...).or(z.string())` contracts and responses remain
`Record<string, unknown>`. Its shared video duration schema includes
4/6/8/10, while the actual allowed subset varies by model.

**Workaround:** Google Flow tools keep per-model model/aspect/duration domains,
positional reference-slot mapping, and tolerant response readers. The generic
numeric-literal reader can inspect the shared duration domain, but Videocity
cannot use it as a per-model source of truth.

**Ask Apicity:** export strict per-model schemas and typed job/entity responses.

## 15. (gap) `@apicity/cost` has no Google Flow provider — OPEN in 0.7.3

The cost table has no `googleflow` provider or Google Flow model slugs.
Videocity therefore prices these tools in `server/src/google-flow-cost.ts`, with
USD based on official Gemini API list rates and Flow credits included as
secondary metadata.

**Ask Apicity:** add Google Flow credit rates and model slugs, or support a
credits-denominated estimate alongside USD.

## 16. (bug) Google Flow path IDs are percent-encoded — OPEN in 0.7.3

The provider applies `encodeURIComponent` to job, asset, account, character, and
voice path IDs. useapi.net IDs contain `:` and `@` and require those characters
raw; encoded job IDs return `400 Invalid job ID format`.

**Workaround:** `server/src/jobs/_google-flow.ts` supplies the provider's fetch
override and decodes the pathname before sending it.

**Ask Apicity:** preserve the raw path-ID characters required by useapi.net.

## 17. (gap) Google Flow requires email where the service defaults it — OPEN in 0.7.3

Voice create/list and character list schemas require `email`, although
useapi.net defaults it for a single configured account and related generation
schemas leave it optional.

**Workaround:** `resolveGoogleFlowEmail` uses an explicit email or resolves the
sole account before calling those methods.

**Ask Apicity:** make those email fields optional consistently.

## 18. (bug) Google Flow singleton character reads lose metadata — OPEN

Singleton character retrieval can return `Untitled Character` and omit
`personalityNotes` while list/create responses retain them.

**Workaround:** `server/src/tools/google-flow-characters.ts` reconciles singleton
and list records and reports conflicts/partial success.

This may be a useapi.net service bug rather than an SDK bug; confirm upstream.

## 19. (bug) ElevenLabs Sound Generation omits the 450-character cap — OPEN in 0.7.3

`ElevenLabsSoundGenerationRequestSchema.shape.text` has only `.min(1)`, while
the live endpoint rejects text longer than 450 characters.

**Workaround:** `MAX_SOUND_GENERATION_PROMPT_CHARS = 450` constrains and caps
extension prompts in `server/src/elevenlabs-audio-extension.ts`.

**Ask Apicity:** add `.max(450)` to the request schema.

## 20. (bug) xAI Responses search contract is stale — OPEN in 0.7.3

The package still types deprecated `search_parameters` and omits the Agent Tools
`x_search` tool from `XaiResponseToolSchema`. The live API rejects the old
search path.

**Workaround:** `verify_x_mentions` uses the typed and accepted
`tools: [{ type: "web_search" }]` path.

**Ask Apicity:** remove or repair `search_parameters` and add `x_search` plus its
output item types.

## 21. (bug) Gemini Omni cost selectors cannot price the published request shape correctly — OPEN in 0.7.3

Two issues exist in `@apicity/cost`'s `gemini-omni-video` entry:

1. `@apicity/kie` defines duration as the string enum
   `"4" | "6" | "8" | "10"`, but the cost selector calls `asNumber` on
   `input.duration`. String durations therefore fall back to 4 seconds.
2. V2V deliberately selects an empty resolution and publishes rate keys such as
   `v2v|6|`. The generic evaluator removes falsey selector values before
   joining, producing `v2v|6`, so no V2V rate is reachable.

**Workaround:** Videocity normalizes Gemini's duration to a number for cost
evaluation, which makes T2V pricing exact. V2V still surfaces an unbounded-cost
warning and alone retains a narrow paygate exception.

**Ask Apicity:** accept numeric strings in the duration selector and either keep
empty selector positions or publish V2V keys without the trailing delimiter.

## 22. (gap) xAI's reference-video limits are absent from the general video schema — OPEN in 0.7.3

`XaiVideoGenerateRequestSchema` correctly exposes the general 1–15 second
duration domain, but `reference_images` has no `.max(7)` and the schema does not
enforce the reference-specific duration cap. xAI documents at most seven
reference images and at most ten seconds for reference-to-video:

- [Video generation](https://docs.x.ai/developers/model-capabilities/video/generation?campaign=imagine-blog)
- [Reference-to-video](https://docs.x.ai/developers/model-capabilities/video/reference-to-video)

**Workaround:** Videocity derives the general duration options, caps local
reference slots at seven, and rejects durations over ten only when references
are present.

**Ask Apicity:** add `.max(7)` and a cross-field refinement for the
reference-specific ten-second limit.

## 23. (bug) Fal Seedream 5 Lite input schema is incomplete — OPEN in 0.7.3

The official Fal schemas for both Seedream 5 Lite endpoints include
`auto_4K` as an `image_size` value, but `FalSeedreamV5LiteImageSizeSchema`
stops at `auto_3K`. The published Apicity request schemas also type
`num_images`/`max_images` as unconstrained numbers even though Fal declares
integer generation counts. The text-to-image schema also omits Fal's
`return_byteplus_urls` input.

- [Fal text-to-image schema](https://fal.ai/models/bytedance/seedream/v5/lite/text-to-image/api)
- [Fal edit schema](https://fal.ai/models/bytedance/seedream/v5/lite/edit/api)

**Workaround:** Videocity derives the published size enum and adds only the
documented `auto_4K` value, while retaining integer validation for image counts.
It no longer sends `seed`; Fal documents seed as an output value, not an input.

**Ask Apicity:** add `auto_4K` and `return_byteplus_urls`, and match Fal's
integer count contract.

## 24. (bug) Fal Nano Banana count and reference constraints are incomplete — OPEN in 0.7.3

Fal documents `num_images` as an integer from 1 through 4 for Nano Banana 2
and Nano Banana Pro, with integer seeds and up to 14 edit references. The
corresponding Apicity 0.7.3 schemas use unconstrained `z.number()` fields for
the non-Lite models and leave their edit arrays unbounded. The original Nano
Banana schemas bound `num_images` correctly but still leave `seed` as a generic
number.

- [Fal Nano Banana 2 API](https://fal.ai/docs/model-api-reference/image-generation-api/nano-banana-2)
- [Fal Nano Banana Pro API](https://fal.ai/docs/model-api-reference/image-generation-api/nano-banana-pro)
- [Fal Nano Banana API](https://fal.ai/docs/model-api-reference/image-generation-api/nano-banana)

**Workaround:** Videocity derives the published prompt, enums, and booleans,
but retains integer 1–4 count validation, integer seeds, and the 14-reference
edit cap where Apicity omits them. Nano Banana 2 Lite already has the correct
integer count constraints and is fully derived.

**Ask Apicity:** use `.int().min(1).max(4)` for `num_images`, `.int()` for
`seed`, and `.max(14)` for Nano Banana 2/Pro edit image arrays.

## 25. (gap) Kie OmniHuman and Volcengine models are absent from the cost registry — OPEN in 0.7.3

`@apicity/kie` exposes `omnihuman-1-5` and
`volcengine/video-to-video-lip-sync`, but `@apicity/cost` has neither model in
its Kie slug map or pricing table. `modelSlug` throws for both and
`computeEstimate` returns an unbounded unknown-model warning.

**Workaround:** the tools retain local `omnihuman` and `volcengine-lipsync`
asset/job slugs, have no cost-display adapters, and are the only complete Kie
models admitted through `COST_TABLE_PENDING_MODELS`.

**Ask Apicity:** publish slugs and rates for both models, and keep Kie model and
cost coverage in lockstep.

## 26. (gap) Fal generation has no cost-estimate contract — OPEN in 0.7.3

`@apicity/cost` classifies Fal endpoints as prohibitive in its endpoint policy,
but `EstimateRequest` does not accept `provider: "fal"` and the bundled pricing
registry contains no Fal models. Videocity therefore cannot ask the package for
a bounded estimate for any Fal queue endpoint.

**Workaround:** Fal-backed tools have no cost adapters and display no estimated
USD price. Their provider-specific request constraints still come from
`@apicity/fal`.

**Ask Apicity:** expose a Fal estimate input keyed by endpoint ID, with either a
maintained local rate snapshot or an explicit dynamic-pricing integration.

## 27. (gap) xAI media generation has no per-unit cost contract — OPEN in 0.7.3

`@apicity/cost` accepts `provider: "xai"`, but its xAI registry and extractor
cover token-billed text models only. The image and video generation endpoints
share Videocity tool names with Kie routes, so using the existing Kie adapter
for an xAI selection would quote the wrong provider's rate.

**Workaround:** Videocity carries `_provider` into cost requests and suppresses
the Kie adapter whenever xAI is selected. xAI image/video calls display an
unknown estimate instead of a false Kie price.

**Ask Apicity:** add endpoint-discriminated per-image and per-second xAI media
rates to `EstimateRequest`.

## 28. (gap) Alibaba media generation has slugs but no cost rates — OPEN in 0.7.3

`@apicity/cost` includes Alibaba slugs for the stable Qwen image models and Wan
2.7 Image Pro, but its Alibaba pricing registry contains token rates only. It
also has no slugs for `wan2.7-image`, `wan2.7-i2v`, or
`wan2.7-videoedit`. Passing these media bodies through the Alibaba token
extractor cannot produce a valid generation estimate.

**Workaround:** Videocity uses the available Qwen/Pro slugs only for naming,
keeps local names for the uncovered models, and registers no Alibaba media cost
adapters.

**Ask Apicity:** add the missing media slugs and endpoint-aware per-image and
per-second Alibaba rates.

## 29. (gap) ElevenLabs TTS text limits are model-specific but absent from the schema — OPEN in 0.7.3

`ElevenLabsTextToSpeechRequestSchema.shape.text` enforces only a one-character
minimum. ElevenLabs publishes different per-request caps by model: for example,
Multilingual v2 accepts more text than Eleven v3, and Flash/Turbo v2.5 accept
substantially more than either.

- [ElevenLabs text-to-speech model limits](https://elevenlabs.io/docs/overview/capabilities/text-to-speech)

Videocity previously imposed one 5,000-character limit on every model. That
rejected valid requests for its default Multilingual v2 model and the larger
Flash/Turbo limits, so the tool now derives the published minimum and leaves the
model-specific maximum to ElevenLabs.

**Ask Apicity:** add a model/text cross-field refinement or export a model-limit
registry that SDK consumers can reuse before submission.
