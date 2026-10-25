# @apicity bugs, gaps, and quirks that Videocity works around

This document tracks provider-package behavior that Videocity cannot consume
directly. It was re-audited against the installed `@apicity/*@0.8.8` packages on
2026-08-07 after Videocity finished adopting 0.8.8 (cost adapters, derived
schemas, removed obsolete shims). Where Apicity exposes a correct schema or
registry entry, Videocity derives the corresponding enum, range, default, string
length, slot count, model slug, or price instead of re-declaring it.

Videobook now uses Apicity 0.18.1 (2026-10-25). Image, video and audio
generation run through the media catalog in `server/src/media/catalog.ts`: each
entry names one provider endpoint, and its fields, enums, ranges, defaults and
prices come from the installed `@apicity/*` zod schemas and `@apicity/cost`.
Nano Banana 2.1 and Seedance 2.5 through KIE are the default image and video
models. GPT Image 2.5 Sunburst and Flare remain selectable; GPT Image 2 stays
hidden for historical records and already queued work.

Every `@apicity/*` package installs from npm. The OpenAI and xAI server
realtime transports, X post metrics lookup and Dropbox upload sessions that
Videobook vendored as patched 0.15.0 tarballs shipped in 0.16.1 (apicity
`ac-j3d6ki.10`–`.12`), so `vendor/` holds no Apicity archives or patches.

The new cost tables price Seedance 2.5 by reference-video presence, and count
input plus output video duration for Seedance, Wan 3.0, MiniMax H3 reference
video, and HappyHorse edits. Estimates resolve local reference durations; KIE
job submission persists the same duration hints outside the provider payload
(fal submissions do not yet; see §41).
Unknown reference durations produce an unavailable estimate instead of an
output-only quote.

Book usage records reported token counts and charges at the provider boundary,
including xAI's `usage.cost_in_usd_ticks` ([cost tracking](https://docs.x.ai/developers/cost-tracking)).
Supported rates are saved as estimates with their pricing version. Requests
without a reported charge or supported rate stay unpriced. The bundled tables do not yet price the current chat
and realtime defaults (`gpt-5.6-sol`, `gpt-realtime-2.1`, and
`grok-voice-think-fast-2.0`). Accounting starts at rollout and does not
reconstruct older usage.

Sections written before 2026-10-16 name per-model tools (`generate_kie_*`,
`generate_fal_*`), `payload-builders.ts`, `cost-adapters.ts` and similar
modules. Commit d8814110 replaced them with the media catalog in
`server/src/media/`, so those references are history. Each OPEN or PARTIAL
section and the status table name the code that carries a workaround today.

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

Update 2026-10-17: that tool and its payload builder are gone. The
`kie:grok-imagine/image-to-video` catalog entry advertises the schema's full
`fun`/`normal`/`spicy` enum plus `task_id` and `index`, and the apicity
refinement rejects `spicy` with external `image_urls` while the request is
built (`spicy mode is unavailable with external image_urls`), before any
submission. Stored requests are no longer rewritten from `spicy` to `normal`.

## 3. (gap) ~~Fal model aliases use output types~~ — RESOLVED in 0.8.8 (adopted)

Kie, Alibaba, xAI, and the other request-oriented packages now export request
aliases as `z.input<typeof Schema>`, matching `*RequestInput` aliases, and
separate parsed output aliases. Videocity removed the broad assembled-object
assertions that had compensated for output-typed defaults in
`server/src/payload-builders.ts`. Narrow casts remain only at app boundaries
where Videocity intentionally accepts a different local wire shape and converts
it to a provider enum or number.

`@apicity/fal@0.8.8` also switched its request aliases to `z.input` and exports
`FalEndpointInputMap` / `FalQueueSubmitRequest<Id>` for endpoint-specific queue
input. Videocity adopted the typed map: `submitFalJob`
(`server/src/jobs/_fal-shared.ts`) is generic over the endpoint id and every
fal job assembles its input as `FalEndpointInputMap["<endpoint>"]`, so unknown
or missing fields now fail at compile time — the defect class that let the
Seedream `auto_4K` junk boolean ship (§23).

One residual upstream nit: `FAL_ENDPOINT_REQUEST_SCHEMAS` keys Qwen edit as
`fal-ai/qwen-image-edit`, but the real fal endpoint (and Videocity's wire id)
is `fal-ai/qwen-image/edit`. That one job therefore stays on the untyped
fallback branch until the upstream key is fixed.

Update 2026-10-17: that note was wrong. Fal's live queue OpenAPI serves
`fal-ai/qwen-image-edit` and returns 404 for `fal-ai/qwen-image/edit`, so the
apicity key is the real endpoint, and the hidden `fal:fal-ai/qwen-image-edit`
catalog entry submits to it.

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

Update 2026-08-25 (vb-2erh.2): the alibaba-native Wan 2.7 video tool was
retired with all Wan 2.x surfaces; see §37 for the Wan 3.0 routing decision.

## 6. (gap) ~~No exported HappyHorse duration schema~~ — RESOLVED

`@apicity/kie` exports `HappyHorseDurationSchema` for integer durations from 3
through 15 seconds. All three HappyHorse 1.1 generation tools and their generated
form schemas now derive from it.

## 7. (gap) ~~`@apicity/x` had no `users/me` endpoint~~ — RESOLVED in 0.7.0

Videocity uses `x.get.v2.users.me()` through
`server/src/x/authenticated-handle.ts`, retaining its local handle cache only as
an offline fallback.

## 8. (quirk) Deliberate Videocity restrictions that differ from a base schema

| Catalog entry                                          | Videobook                                  | Base Apicity schema                             | Reason                                                              |
| ------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------- |
| `kie:bytedance/seedance-2-5` with a frame              | `aspect_ratio` set to `adaptive`           | rejects fixed ratios for frame tasks            | keeps frame requests valid instead of failing; see §40              |
| `fal:bytedance/seedance-2.0/us/reference-to-video`     | requires an image or video reference       | references optional; audio needs a visual       | without a visual reference the request is text-to-video             |
| `fal:bytedance/seedance-2.5/us/reference-to-video`     | v2v and extend modes require a video       | `task` editing/extension with optional videos   | editing and extension continue a reference video; see §42           |

The catalog expresses these with `frameOptions` and mode `requireAny` in
`server/src/media/catalog.ts`; every other field, enum and range comes straight
from the apicity schemas. Before the catalog (d8814110) this table listed the
Grok `spicy` and `index` filters of the removed `generate_grok_imagine_video`
tool (§2). The Bria guided background removal row ended in 0.16.0, when the
schema itself started requiring `image_url` (§42).

## 9. (gap) ~~HappyHorse 1.1 slugs and pricing~~ — RESOLVED in 0.6.1

`@apicity/cost` prices the three `happyhorse-1-1/*` generation endpoints.
Videocity uses their actual model slugs and no longer admits them through a
missing-cost paygate exception.

## 10. (gap) ~~Seedance 2 Mini slug and pricing~~ — RESOLVED in 0.6.1

`@apicity/cost` registers `bytedance/seedance-2-mini` and its 480p/720p
per-second rates. Videocity uses `modelSlug`, a normal cost adapter, and bounded
paygate pricing.

## 11. (bug) ~~Kie media fields require public URLs before upload~~ — RESOLVED in 0.8.8 (verified retired)

`@apicity/kie` accepts plain strings for Seedance 2 Mini reference media and
Qwen2 image-edit media at the construction boundary, so bare `@img-*` / `@vid-*`
slugs validate. The videobook shims are gone: the Seedance 2 shared tool derives
reference fields from the schema (no pre-check omission) and
`slugAsPlaceholderUrl` no longer exists anywhere in `server/src`. Jobs still
upload local assets to public CDN URLs before calling Kie — that step is a
provider requirement, not a workaround.

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

## 22. (gap) ~~xAI reference-video duration cap absent~~ — RESOLVED in 0.8.8 (adopted)

`@apicity/xai` carries the cross-field refine "duration must be at most 10
seconds when using reference images" on `XaiVideoGenerateRequestSchema` (plus
the `.max(7)` on `reference_images` / `reference_image_file_ids`).
`generate_grok_imagine_ref_video` validates the assembled request through that
schema and surfaces the schema message, so the rule and any future changes
derive from the package; the hand-rolled `Number(duration) > 10` check and its
hard-coded error string are gone.

## 23. (bug) ~~Fal Seedream 5 Lite input schema incomplete~~ — RESOLVED in 0.8.8 (adopted)

`@apicity/fal` documents `auto_4K` as an `image_size` **preset** in
`FalSeedreamV5LiteImageSizeSchema` (not a standalone boolean), carries no
`auto_4K` field on the request schemas, and bounds `num_images` / `max_images`
to integers in [1, 6]. Videocity's Seedream fal tools dropped the hand-declared
`auto_4K: z.boolean()` — a junk field the untyped queue submission let through
(§3), so a 4K request silently got the default size — and derive `image_size`
(with the `auto_4K` preset) and the count bounds via `apicityField`.
`return_byteplus_urls` is documented on the text-to-image surface only and is
deliberately not exposed: Videocity ingests through its own CDN download path.

Update 2026-10-17: the catalog derives every option from the schema, so
`return_byteplus_urls` is now an ordinary option on the hidden
`fal:fal-ai/bytedance/seedream/v5/lite/text-to-image` entry. Completion
downloads whatever output URL fal returns.

## 24. (bug) ~~Fal Nano Banana edit reference caps missing~~ — RESOLVED in 0.8.8 (decided: no cap)

Upstream investigated and concluded Fal documents no `image_urls` cap for the
Nano Banana 2 / Pro edit endpoints, so `@apicity/fal` deliberately leaves the
arrays unbounded. Videocity removed its local `.min(1).max(14)` append on
`image_refs` (kept `.min(1)`) and defers to the provider contract — a
provider-side rejection would surface naturally. The original Fal-docs
rationale for the local cap is gone, so this stops being an upstream ask.

## 25. (gap) ~~Kie OmniHuman and Volcengine models are absent from the cost registry~~ — RESOLVED in 0.8.0

`@apicity/cost@0.8.0` registers slugs (`oh1p5`, `vlipsync`) and per-second rates
for both models. Schemas still omit duration (output follows driving audio /
source video), so callers pass the typed `costHints.durationSeconds` side
channel — see §30.

Tools use `modelSlug("kie", …)` for asset/job names; cost adapters + job
handlers pass `KieCostHints` from source audio/video metadata.
`COST_TABLE_PENDING_MODELS` was removed; OTP minting fails closed without a
duration hint.

## 26. (gap) ~~Fal cost coverage is image-only~~ — RESOLVED in 0.8.8 (adopted)

`@apicity/cost` prices every fal family Videocity ships: Kling Video v3
pro/standard t2v+i2v (audio-tiered per second), Seedance 2.0 and Fast
t2v/i2v/r2v (token-metered per second), Wan v2.7 t2v/i2v (resolution-tiered)
and r2v/edit-video (flat per second), Wan/Qwen/Seedream/Nano-Banana/Grok image
and edit endpoints, and Grok Imagine video i2v/r2v/extend. `FAL_ADAPTERS` in
`server/src/cost-adapters.ts` now covers all of them. The "—" path remains only
for `google/nano-banana-2-lite`(/`-lite/edit`), which upstream declares
dynamic-pricing, and `xai/grok-imagine-video/edit-video`, which has no
published rate.

Update 2026-08-25 (vb-2erh): all Wan 2.7 fal tools/adapters were retired
(vb-2erh.2). Wan 3.0 Prime t2v/i2v/r2v is priced via `falVideo`
($0.05/output second); the base `alibaba/wan-3.0/*` tier and
`alibaba/qwen-image-3/edit` are upstream dynamic-pricing (per compute second),
so they keep the unpriced "—" path with no adapter.

Update 2026-10-17 (0.15.0): `@apicity/cost` replaced the per-second fal
Seedance 2.0 and 2.5 tables with output-token metering that a request cannot
determine, so every fal Seedance endpoint, US twins included, now estimates $0
with a warning. Fal endpoints first catalogued from 0.15.0 are covered in §41.

## 27. (gap) ~~xAI media generation has no per-unit cost contract~~ — RESOLVED in 0.8.0

Per-second video (`grok-imagine-video*`) and per-generation image
(`grok-imagine-image*`) rates are registered. Video units read top-level
`duration` only. Videocity's `getCostAdapter` routes `_provider: "xai"` to
`XAI_ADAPTERS` (docs.x.ai model keys), not Kie `grok-imagine/*` slugs.

## 28. (gap) ~~Alibaba media cost is incomplete for non-pro image~~ — RESOLVED in 0.8.8 (adopted)

`@apicity/cost` registers `wan2.7-image` (slug `wan2p7`) at the
International-region list rate of $0.03/image; the pro rate stays $0.075.
`ALIBABA_ADAPTERS` covers `generate_alibaba_wan_2_7_text_to_image` via the
normal `alibabaImage("wan2.7-image")` adapter; the unpriced "—" display path
for that tool is gone.

Update 2026-08-25 (vb-2erh.2): `generate_alibaba_wan_2_7_text_to_image` was
retired with all Wan 2.x surfaces, so `ALIBABA_ADAPTERS` no longer carries a
Wan entry; see §37.

## 29. (gap) ~~ElevenLabs TTS text limits are model-specific but absent from the schema~~ — RESOLVED in 0.8.0

0.8.0 exports `ELEVENLABS_TEXT_TO_SPEECH_MODEL_TEXT_LIMITS` and enforces
per-model caps (with a default-model path when `model_id` is omitted) plus a
static 40k ceiling. Videocity leaves max validation to the package.

## 30. (gap) ~~Per-second cost extractors need out-of-band duration~~ — RESOLVED in 0.8.8 (adopted)

`@apicity/cost` prices several Kie models per second while their request schemas
have no duration field (output follows source/driving media):

| Model                                | Duration source |
| ------------------------------------ | --------------- |
| `happyhorse/video-edit`              | source video    |
| `kling-3.0/motion-control`           | motion video    |
| `omnihuman-1-5`                      | driving audio   |
| `omnihuman-2-0`                      | driving audio   |
| `volcengine/video-to-video-lip-sync` | driving audio   |

Videocity maps its measured `KieCostHints.duration` to the formal
`EstimateRequest.costHints.durationSeconds` side channel
(`toUpstreamCostHints` in `server/src/cost-adapters.ts`); the estimate-only
top-level `duration` payload injection (`normalizeKieCostPayload`) is deleted.
Everything else is unchanged: job handlers measure source media, hints persist
in `.generation-cost-hints.json` for queued re-submit, the OTP hashes the
verbatim wire request, `estimate_cost` enriches from asset `original` duration
metadata, and minting fails closed when no duration is readable.

Since the generic media catalog, each of these entries names the media its
output length follows with `outputLength` in `server/src/media/catalog.ts`.
`estimate_cost` and queued `generate_media` jobs both pass that media's length
as `costHints.durationSeconds` (vb-khz1, vb-77ty), so the KIE paygate estimate
is bounded and the usage row is priced. HappyHorse video edit also passes the
source as `inputDurationSeconds`: its page bills "Unit Price × (Input Video
Duration + Output Video Duration)" and returns a video as long as its 3-60 s
input. Kling 3.0 motion control output "will normally match the length of the
uploaded reference video" (3-30 s, at most 10 s with `character_orientation:
image`); a shorter output from complex motion is not refunded. Volcengine lip
sync follows its audio, not its source video: KIE's docs state the "output
duration follows the audio duration", trimming a longer source video and
looping a shorter one (read 2026-10-25).

## 31. (bug) ~~Fal area pricing guesses omitted image sizes~~ — RESOLVED in 0.8.6

`@apicity/cost` uses the documented `landscape_4_3` default for Flux dev, Flux
schnell, and Qwen Image. Qwen Image Edit publishes no fixed default, so omission
produces an unbounded warning; Hunyuan instruct edit continues to warn for its
upstream `auto` default. Explicit presets are still rounded up per image. No
Videocity change was needed.

## 32. (bug) ~~Kling 3.0 multi-shot requests can select the wrong sound rate~~ — RESOLVED in 0.8.6

`@apicity/cost` selects the sound tier for `multi_shots: true` plus omitted
`sound`, matching KIE's sound-enabled behavior; explicit `sound: false`
continues to use the base tier. No Videocity change was needed.

## 33. (gap) ~~ElevenLabs MCP metadata hides the default-model text cap~~ — RESOLVED in 0.8.6 (n/a for Videocity)

The provider schema enforces 10,000 characters when `model_id` is omitted and a
model-specific cap up to 40,000 when explicit, and the conditional rule is now
in the root request-schema description. The remaining MCP-surface half concerns
`@apicity/mcp-server`, which Videocity does not install — Videocity's own TTS
tool leaves max validation to the package (§29), so nothing here applies.

## 34. (gap) ~~KIE Nano Banana has a slug but no price~~ — RESOLVED in 0.8.6

`@apicity/cost` records KIE's published 4-credit rate as $0.02/image and removed
the model from the unpriced allowlist. No Videocity change was needed.

## 35. (gap) ~~KIE MiniMax H3 ships without cost slugs or pricing~~ — RESOLVED in 0.8.8 (adopted)

`@apicity/cost@0.8.8` registers all three `minimax-h3/*` endpoints under the
`mmh3` slug and prices them per second by resolution tier — 768P $0.1125/s, 2K
$0.1825/s (22.5 / 36.5 credits/s, verified kie.ai/pricing 2026-08-06), with 2K
as the documented upstream default. Videocity adopted the package contract end
to end:

- the local ceiling table (`server/src/minimax-h3-cost.ts`) and its two call
  sites (`mintKieOtp`, `estimateOne`) are deleted — the stands-down assertion
  fired as designed;
- the three generate tools use `modelSlug("kie", "minimax-h3/*")` like every
  other kie tool (new display labels are prefixed `mmh3-`; artifact identity is
  the grid address, so existing artifacts are unaffected);
- `VIDEO_COST_ADAPTERS` prices all three tools via `kieResolutionVideo` with a
  stated 6s default duration (the schema requires duration and has no default).

Related 0.8.8 pricing change with a paygate consequence: `grok-imagine/upscale`
is now floor-priced at its lowest published tier ($0.05) with a permanent
warning naming the two higher tiers no request field can select. `mintKieOtp`
therefore fails closed only when the estimate is zero (unknown model or
underivable units); a positive estimate with warnings is a floor the package
stands behind and is admitted.

## 36. (gap) ~~KIE MiniMax H3 reference clip duration bounds absent from schema~~ — RESOLVED UPSTREAM in 0.16.0

`MiniMaxH3ReferenceToVideoInputSchema` bounds only reference counts (max 9
images / 3 videos / 3 audios). Kie additionally enforces a per-clip duration
window at runtime: a live reference-to-video submit with a ~29.9s clip failed
with

```
content[2].video_url: invalid param: video duration 29917 ms,
expected [2000, 15000] ms (2013) (400)
```

Because the guard cannot see it, such a payload validates, mints a paygate
OTP, and burns a task attempt before Kie rejects it. Whether an equivalent
bound applies to reference audio is unverified — no audio rejection has been
observed.

**Former workaround (removed in d8814110, now a catalog rule):** `generate_kie_minimax_h3_reference_to_video` checked each plain
video ref's local `original` duration metadata before creating the output
artifact and fails fast outside 2–15s. Unknown durations pass through (Kie
stays the authority); slashed refs (`@asset/file.mp4`) are skipped because
artifact metadata does not describe sibling files.

**Ask Apicity:** document the reference clip duration window on the
reference-to-video schema (description at minimum), and confirm whether the
same bound applies to `reference_audio_urls`.

Update 2026-10-17 (0.15.0): the schema still bounds only reference counts. The
local check described above lived in the per-model tool, which d8814110
removed, so `kie:minimax-h3/reference-to-video` currently has no pre-submit
duration guard and an over-long clip fails at Kie after the paygate OTP.
Restoring it as catalog data is tracked in vb-6rct.

Update 2026-10-17 (0.16.1): `@apicity/kie` exports
`MiniMaxH3ReferenceClipDurationMs` (`ac-j3d6ki.2`): 2,000–15,000 ms per file and
15,000 ms combined, for reference videos and, per Kie's docs, reference audio
too. The schema descriptions state the same window. A URL carries no duration,
so the schema cannot enforce it. The `kie:minimax-h3/reference-to-video`
catalog entry now carries the constant as its `rules.refDurationMs`, and
`checkRefDurations` (`server/src/media/refs.ts`) applies it to every video and
audio ref with a known `original` duration, in `generate_video` before the
artifact exists and in the job before any upload or submission (vb-6rct).
Unknown durations and URLs still pass through to Kie.

---

## 37. (decision) Native DashScope Wan 3.0 intentionally not carried — DECIDED 2026-08-25 (wontfix)

With the Wan 2.x retirement (vb-2erh.2) the last alibaba-native
(DashScope) video tool was removed. `@apicity/alibaba` 0.11.0 reaches Wan
3.0 only through the versioned-id alias escape hatch (`wan3.0-i2v`,
`wan3.0-videoedit`), which skips the listed-model refinements for ratio /
audio_setting, and there is no native Prime tier. Since fal and kie both
cover Wan 3.0 and Wan 3.0 Prime end-to-end with first-class schemas and
cost entries, native DashScope video is deliberately dropped in favor of
those routes. Revisit only if Apicity ships listed Wan 3.0 enums with
native pricing.

---

## 38. (gap) KIE Qwen 2.1 cost slugs and pricing — RESOLVED in 0.13.2

`@apicity/cost` 0.13.2 registers `qwen2-1/text-to-image` and
`qwen2-1/image-to-image`, including their slugs and resolution rates.
Videobook derives the default resolution from the provider schemas and uses
these rates in previews and recorded usage. The i2i schema still accepts
1–10 reference images and an optional `mask_url` field that the picker does
not expose, matching the other Qwen tools.

---

## 39. (gap) ~~xAI realtime fields the vendored types do not model~~ — RESOLVED in 0.16.1 (adopted)

`XaiRealtimeSession` and the vendored realtime event types (`@apicity/xai`
0.15.0, commit recorded in `vendor/XAI_REVISION.txt`) do not model two xAI
speech-to-speech features Videobook uses. `conversation.item.create` with
`item.type = "force_message"` (an assistant item forced into the transcript
without a response.create round-trip) drives the voice activation line; the
item and content shapes ride `Record<string, unknown>` fields, so no vendor
patch is needed, but the events are untyped. `audio.output.speed` (0.7-1.5,
default 1.0) is likewise absent from `XaiRealtimeAudioConfig`, so the xAI
session leaves the pace at the provider default while the OpenAI session
pins speed 1 explicitly. Add the fields upstream rather than patching the
vendored tarball; until then the activation path stays dynamically shaped
and xAI pace is not configurable.

Update 2026-10-17 (0.16.1): the published xAI realtime transport
(`ac-j3d6ki.11`) types both. `xaiVoiceActivationEvent` returns a typed
`XaiRealtimeConversationItemCreate` carrying an `XaiRealtimeForceMessageItem`,
and the xAI session pins `audio.output.speed` to 1 like the OpenAI session.

---



## 40. (gap) ~~Seedance 2.5 frame aspect restriction~~ — RESOLVED in 0.14.0

KIE rejects first-frame and first/last-frame requests with a fixed aspect ratio:
`Seedance 2.5 first-frame and first-last-frame tasks only support adaptive aspect ratio`.
Since 0.14.0 `Seedance25RequestSchema` enforces the same rule with that message,
and its `aspect_ratio` description says frames require `adaptive`. Videobook
keeps setting frame requests to `adaptive` (the `kie:bytedance/seedance-2-5`
catalog entry's `frameOptions`, applied by the shared request builder for
generation, previews, notebook runs and retries), so a frame request succeeds
instead of failing validation. Frame controls explain that output follows the
first image and prevent fixed-ratio selection. Text and reference modes retain
their supported fixed ratios.

---

## 41. (gap) Fal 0.15.0 endpoints without a local rate — UPSTREAM BY DESIGN in 0.16.0

Videobook catalogues 32 fal image and video endpoints first published in
0.15.0. `@apicity/cost` 0.15.0 has no local rate for 17 of them: fal bills
them by compute seconds, output tokens or delivered output metadata, which a
request cannot determine. `computeEstimate` returns $0 with a warning that
points to fal's pricing-estimate API, so estimates, previews and book usage
show them as unpriced:

- `google/nano-banana-2.1` and `google/nano-banana-2.1/edit`
- `fal-ai/flux-2-flex`
- `bytedance/seedance-2.0/us/*` and `bytedance/seedance-2.5/us/*` text, image
  and reference video, plus `bytedance/seedance-2.5/draft/complete`
- `fal-ai/kandinsky6-pro/*` and `fal-ai/kandinsky6-lite/*` text and image
  video, `fal-ai/kandinsky6-vsr` and `fal-ai/kandinsky6-vsr/lite`
- `mirelo-ai/sfx2.0/video-to-video`

The other 15 are priced: Bria guided background removal ($0.03 per image),
Bria Fibo Edit 1.5 Expand ($0.04 per image), Marigold V2 ($0.03 per image), the
five H3 Max styles and H3 Max Relight ($0.08 per second), Kling O3 Standard
image-to-video, Vidu Q4, PixVerse VibeMV, Pixelcut Looping Video and Creatify
Boreal. Relight and VibeMV take their seconds from the source video or song,
which their requests do not carry (the §30 out-of-band duration contract).
Estimates resolve those durations from local metadata, but fal submissions do
not yet persist duration hints, so their usage rows stay unpriced, as for the
existing H3 Max Recast, Insert Video and Turbo Extend entries (vb-t2pr).

Update 2026-10-17 (0.16.1): `@apicity/cost` prices fal Seedance from ByteDance's
output sizes (`ac-j3d6ki.3`, 1080p corrected in `ac-i5zo6h`): width × height ×
frames / 1024 tokens at each card's rate, with frames = 24 × duration + 1. The
2.0 and 2.5 US text-to-video, 2.0 US image-to-video and 2.5 US
reference-to-video entries now estimate from resolution, aspect ratio and
duration. Three Seedance requests remain unpriced, each with a specific
warning: 2.0 US reference-to-video without `video_urls`, 2.5 US image-to-video
(the output follows the image), and the draft completion (it keeps the draft's
aspect ratio). The other ten stay dynamic, and `FAL_DYNAMIC_BILLED_UNITS`
(`ac-j3d6ki.4`) names each one's billed unit in the warning: Nano Banana 2.1
and its edit (token-summed $1 units), FLUX.2 Flex (processed megapixels), the
four Kandinsky 6 text and image models (compute units), both Kandinsky 6 VSR
models (output megapixels × frames) and Mirelo SFX 2.0 (output seconds ×
samples). None is a constant a request determines, so a local table cannot price them.

Update 2026-10-21 (vb-x1xh): when `FAL_ADMIN_API_KEY` is set, estimates,
previews and usage rows for dynamically billed fal endpoints call
`resolveFalDynamicEstimate` with `callQuantity: 1`. That is fal's historical
average per call, and the estimate warns that the average ignores this request.
Queue results still omit `x-fal-billable-units`, so a finished run keeps that
same average rather than an exact unit price. Without the admin key, or when
the pricing call fails, the row stays at the local $0 with its warning.
Statically priced endpoints never call fal. Two Seedance requests stay on the
local formula and remain $0 until the request supplies the missing field:
2.0 US reference-to-video without `video_urls`, and 2.5 draft completion
without the draft's aspect ratio and duration. Those two are not historical
averages.

---

## 42. (quirk) Fal 0.15.0 request shapes Videobook adapts — CONSUMER REQUIREMENT

- ~~`bria/guided-remove-background` defaults `image_url` to Bria's sample
  photo~~. Since 0.16.0 the schema requires `image_url` (`ac-j3d6ki.1`), so the
  catalog entry's image-only mode is gone and a run without a source image fails
  as an ordinary missing image ref.
- `mirelo-ai/sfx2.0/video-to-video` defaults `num_samples` to 2. Videobook keeps
  only the first output, so the catalog sends 1. Its prompt field is
  `text_prompt`.
- `pixverse/music-video/vibemv` has two optional image fields. The first image
  reference fills `image_url` (character); the second fills `style_image_url`,
  which fal only uses with the Custom style.
- Seedance 2.0/2.5 US and Kling O3 Standard image-to-video name the start frame
  `image_url`. Videobook maps it to the first-frame role so frame connections
  work as they do for KIE Seedance.
- `bytedance/seedance-2.5/us/reference-to-video` selects reference, editing or
  extension with `task`. Videobook exposes these as the r2v, v2v and extend
  modes; the mode sets `task`.
- Fal Vidu Q4 reference-to-video names inputs `[@reference_image_N]` and
  `[reference_audio_N]` (no `@` for audio). The `vidu` prompt dialect writes
  exactly that form.
- ~~`@apicity/cost` `MODEL_DISPLAY` has no titles for most new fal endpoints~~.
  Since 0.16.0 every fal endpoint has a display name and the five H3 Max styles
  have their own (`ac-j3d6ki.6`), so those catalog entries take the package
  name. Local titles remain only to add a provider suffix such as "(Kie)" or to
  tell the Seedance 2.5 draft completion apart from Seedance 2.5.

---

## 43. (decision) Fal twins and draft completion hidden from the picker — DECIDED 2026-10-17

The fal routes for Nano Banana 2.1, Vidu Q4 and Seedance 2.5 US duplicate
models the picker already serves through KIE, so they are `hidden` catalog
entries, like the older fal Nano Banana and Wan 3.0 routes. They remain
available through `generate_image`, `generate_video` and
`list_generation_models` with `include_hidden`. `bytedance/seedance-2.5/draft/complete`
is hidden as well: it needs a `draft_id` from a fal Seedance 2.5 draft request,
and no catalogued model creates drafts, so callers must pass `draft_id` in
`options`.

KIE 0.15.0 adds no image or video model. Its Gemini 2.5 Flash and Gemini 3
Flash chat endpoints were replaced by Gemini 4 Argon (unused by Videobook), and
`qwen/text-to-image` lost its `image_size` default; Videobook catalogues only
the versioned Qwen models, so neither change reaches the catalog.

---

## 44. (quirk) MachGen 0.17.0 request shapes Videobook adapts — CONSUMER REQUIREMENT

`@apicity/machgen` publishes one generic `MachGenGenerateRequestSchema` for every
model and task type, so `server/src/media/machgen.ts` keeps a per-model table
taken from MachGen's model capability contract as captured on 2026-10-22: task
types, heights, durations, aspect ratios, audio, seed, and end-frame support.
Each catalog entry exposes flat fields (`first_frame_url`, `last_frame_url`,
`reference_*_urls`, `duration`, `resolution`, `aspect_ratio`, `generate_audio`,
`seed`). The wrap derives `task_type` from the connected media and nests the
settings in `video_config`.

- MiniMax H3 offers 480p, 768p and 1440p. MachGen marks 1080p private, and
  `@apicity/cost` publishes no 1080p rate. 1440p and first-plus-last-frame
  runs stop at 15 seconds. A lone last frame is sent with `keyframe_indices: [-1]`.
- Reference lists use the apicity schema caps (9 images, 3 videos, 3 audio
  clips), although MachGen's contract allows more for Seedance 2.5 and Wan 3.0.
- Wan 3.0 always sends the documented `aspect_ratio: "adaptive"`, `fps: 30`,
  `audio: true`, because MachGen rejected requests without them at zero charge.
- Prompts name references in plain words (`natural_strip_frames`). Videobook
  sends no subject maps, so MachGen's `@handle` validation does not apply.
- MachGen has no per-task web page, so provider status shows the task id
  without a link. The client raises timeouts and aborts as `MachGenError` 408
  and 499, so polls keep a task on 408, 429 and 499 and fail it on other 4xx.

---

## 45. (gap) Fal queue status and result have no endpoint catalog rows — RESOLVED in 0.18.1

Videobook polls fal queue jobs with `v1.queue.status` and `v1.queue.result`
(`server/src/jobs/_image-edit-adapter.ts` and
`server/src/tools/reconcile-project-work.ts`), and HAR capture names each call
by that SDK dot path. The SDK sends
`GET https://queue.fal.run/{endpoint_id}/requests/{request_id}/status` and
`GET https://queue.fal.run/{endpoint_id}/requests/{request_id}`, but the 0.18.0
endpoint catalog (`scripts/endpoint-docs.tsv`, bundled with `@apicity/cli`) has
no fal row for either. Its only queue row is `v1.queue.submit`.
`apicity har report` resolves a capture only when its endpoint equals a
catalog dot path, so it lists every fal poll as an unresolved `not-in-catalog`
call, and a poll that fails with a provider error never reaches the report's
outcome counts or provider errors.

An offline reproduction with four stubbed captures (submit, status, result and
a 422 status poll) gives one resolved call and three unresolved calls under the
0.18.0 CLI. With the two rows added to a scratch copy of its catalog, all four
calls resolve and the 422 counts as a provider error.

Videobook keeps the SDK names rather than renaming the captures to a path the
catalog does not contain. Apicity `ac-8zeblu` asks for `v1.queue.status` and
`v1.queue.result` rows. Once a release ships them, vb-7871 checks that fal
polling captures resolve in `apicity har report` and marks this section
resolved.

**Resolved in 0.18.1 (2026-10-25, vb-7871).** Apicity 0.18.1, installed
since Videobook 0.3.1, ships both rows: the `@apicity/cli` 0.18.1 catalog lists
`v1.queue.status` and `v1.queue.result` (`ac-8zeblu`) along with the other fal
SDK methods written as method shorthand (`ac-3ba9xb`). The fal requests
Videobook sends are unchanged. The same offline reproduction under the 0.18.1
CLI (`apicity har report <dir> --no-baseline --json`) gives 4 calls (3 ok,
1 provider error), 0 unmatched exchanges and 0 unresolved calls, and the 422
poll is listed under `v1.queue.status` provider errors with the field
`request_id`. `server/src/har-capture.test.ts` checks the capture names and
outcomes against the released rows. The submit row's path is a single
`{endpoint_id}` placeholder, which `findMatchingRow` cannot match against a
multi-segment endpoint id, so the report, like the test, attributes a submit
capture as the capture's only entry.

---

| Status       | Sections                                                            | What Videocity still carries                           |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------ |
| **RESOLVED** | §36 MiniMax H3 reference clip bounds (upstream constant)            | catalog rule reads the apicity constant (vb-6rct)      |
| **RESOLVED** | §38 KIE Qwen 2.1 cost slugs/pricing                                 | catalog defaults and rates read from apicity           |
| **RESOLVED** | §39 xAI realtime force_message / audio.output.speed                  | typed activation event; xAI speed pinned to 1          |
| **RESOLVED** | §40 Seedance 2.5 frame aspect ratio                                 | adaptive `frameOptions` and mode-aware controls        |
| **RESOLVED** | §41 dynamically billed fal endpoints                                | historical average per call when `FAL_ADMIN_API_KEY` is set (vb-x1xh) |
| **BY DESIGN**| §41 Seedance requests the local formula cannot fix                  | 2.0 US r2v without `video_urls`; 2.5 draft completion without the draft's ratio and duration |
| **QUIRK**    | §42 fal 0.15.0 request shapes                                       | catalog modes, refs, defaults, `vidu` dialect          |
| **DECIDED**  | §43 hidden fal twins and draft completion                           | `hidden` catalog entries                               |
| **QUIRK**    | §44 MachGen 0.17.0 request shapes                                   | per-model table in `server/src/media/machgen.ts`       |
| **RESOLVED** | §45 fal queue status/result catalog rows (`ac-8zeblu`, 0.18.1)      | none; captures keep the SDK dot paths (vb-7871)        |
| **RESOLVED** | §3, §11, §22–24, §26, §28, §30–32, §34–35                          | adopted upstream contracts; local workarounds deleted  |
| **RESOLVED** | §1–2, §4–7, §9–10, §12–13, §19–21, §25, §27, §29              | no local shim                                          |
| **N/A**      | §33 ElevenLabs MCP metadata                                         | `@apicity/mcp-server` not installed                    |

**Deliberate product quirks (not Apicity defects):** §8 table and §42 fal request shapes. The §2 Grok
`spicy` filter and the §23 `return_byteplus_urls` omission ended with the
per-model tools (d8814110).

**Upstream verification:** The §3 Qwen edit key note was
checked against fal's live OpenAPI on 2026-10-17: the apicity key is correct.

**0.11.0 Wan 3.0 / Qwen 3 update (2026-08-25, vb-2erh):** all Wan 2.x surfaces
are retired (§5, §26, §28 updates above). Wan 3.0 + Prime ship via six fal
tools and two kie omni tools with the kie picker route primary; native
DashScope video is deliberately dropped (§37). Qwen Image 3 edit ships via
`generate_fal_qwen_3_0_edit_image`; like base Wan 3.0 it is upstream
dynamic-pricing, so it has no cost adapter (§26 update).

**0.15.0 update (2026-10-17, vb-kqzp):** all 13 Apicity packages resolve
0.15.0; OpenAI, xAI, X and Dropbox are vendored as the published tarballs plus
their unchanged patches. The 32 new fal image and video endpoints are catalog
entries, 24 of them in the picker (§41–§43). The fal audio, 3D, robotics and
routing endpoints new in 0.15.0 (Mureka, Mirelo SFX audio, VEED Clean Audio,
Grok Voice, Meshy 6 Lite Retexture, FLUX.3 Action SO-101, OpenRouter decisions)
are not catalogued.

**Upstream tracking (2026-10-17):** apicity epic `ac-j3d6ki` carried the open
asks: `.1` Bria sample-photo default (§42), `.2` MiniMax H3 clip window (§36),
`.3` fal Seedance estimates and `.4` the other unpriced fal endpoints (§41),
`.6` missing `MODEL_DISPLAY` names (§42), and `.10`–`.12` publishing the OpenAI
and xAI realtime transports (with §39's types) and the X and Dropbox changes
Videobook vendored. All of them shipped in 0.16.0 and 0.16.1.

**0.16.1 update (2026-10-17, vb-leqo):** all 13 Apicity packages resolve 0.16.1
from npm, and the four vendored archives, their patches and revision notes are
deleted. Adopted upstream contracts: the OpenAI `./realtime` and xAI
`./realtime` transports, X post metrics, Dropbox upload sessions, typed xAI
`force_message` and `audio.output.speed` (§39), `MODEL_DISPLAY` names for the
fal entries (§42), and the schema's required Bria `image_url` (§8, §42).
The §36 clip window is enforced from the apicity constant (vb-6rct). Usage
rows stamp the installed `@apicity/cost` version in `pricingVersion` instead of
a hard-coded `apicity-0.15.0`. No vendored Apicity patch remains. Dynamically
billed fal endpoints use fal's historical average per call when
`FAL_ADMIN_API_KEY` is set (§41, vb-x1xh). Seedance 2.0 US reference-to-video
without `video_urls`, and Seedance 2.5 draft completion without the draft's
ratio and duration, stay on the local formula.

**0.17.0 update (2026-10-23, vb-9sht):** all 13 Apicity packages resolve 0.17.0,
and `@apicity/machgen` adds six MachGen video models as provider tasks (§44).
KIE adds `bytedance/seedance-2-5-draft`, catalogued and visible because the KIE
Seedance 2.5 model now has the `draft` option that creates its drafts. A draft
rendered in the same book supplies the completion's billed seconds; otherwise
the estimate stays at $0 with the upstream warning. KIE's new chat models
(`gpt-6-1-sol`, `claude-haiku-5-5`) do not apply: Videobook chat routes through
OpenAI (vb-ga0z). KIE Seedance 2.5 rates moved to the 2026-10-22 price page.
