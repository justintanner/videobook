# @apicity bugs, gaps, and quirks that Videocity works around

This document tracks provider-package behavior that Videocity cannot consume
directly. It was re-audited against the installed `@apicity/*@0.8.8` packages on
2026-08-07 after Videocity finished adopting 0.8.8 (cost adapters, derived
schemas, removed obsolete shims). Where Apicity exposes a correct schema or
registry entry, Videocity derives the corresponding enum, range, default, string
length, slot count, model slug, or price instead of re-declaring it.

Videobook now uses Apicity 0.13.0 (2026-09-27). GPT Image 2.5 Sunburst is
the default image renderer, with Flare available; both choose text-to-image or
image-to-image according to reference inputs. GPT Image 2 definitions remain
only for historical records and already queued work. Saved cells explicitly
configured for a retired GPT model can select either 2.5 renderer before running
again; their prompts and existing results remain intact.

Published `@apicity/openai` and `@apicity/xai` 0.13.0 still omit Videobook's
existing server realtime transports. Their vendored 0.13.0 archives carry the
same transport additions, with reproducible package patches and base URLs in
`vendor/OPENAI_REVISION.txt` and `vendor/XAI_REVISION.txt`.

The new cost tables price Seedance 2.5 by reference-video presence, and count
input plus output video duration for Seedance, Wan 3.0, MiniMax H3 reference
video, and HappyHorse edits. Estimates resolve local reference durations; job
submission persists the same duration hints outside the provider payload.
Unknown reference durations produce an unavailable estimate instead of an
output-only quote.

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

| Tool/field                                           | Videocity                              | Base Apicity schema                                    | Reason                                                                           |
| ---------------------------------------------------- | -------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `generate_grok_imagine_video.mode`                   | `fun`/`normal`                         | includes conditionally valid `spicy`                   | Videocity exposes only the external-image path; see §2                           |
| `generate_grok_imagine_video` with `image_urls`      | omits `index`                          | optional `index` still accepted alongside `image_urls` | Kie docs: `index` is `task_id`-only; see §2                                      |

These are the only deliberate restrictions represented by
`APICITY_DERIVE_SKIP` or by targeted validation against an otherwise reusable
strict provider schema. Google Flow's broader local contract is tracked in §14.

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
| `volcengine/video-to-video-lip-sync` | source video    |

Videocity maps its measured `KieCostHints.duration` to the formal
`EstimateRequest.costHints.durationSeconds` side channel
(`toUpstreamCostHints` in `server/src/cost-adapters.ts`); the estimate-only
top-level `duration` payload injection (`normalizeKieCostPayload`) is deleted.
Everything else is unchanged: job handlers measure source media, hints persist
in `.generation-cost-hints.json` for queued re-submit, the OTP hashes the
verbatim wire request, `estimate_cost` enriches from asset `original` duration
metadata, and minting fails closed when no duration is readable.

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

## 36. (gap) KIE MiniMax H3 reference clip duration bounds absent from schema — OPEN in 0.8.8

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

**Workaround:** `generate_kie_minimax_h3_reference_to_video` checks each plain
video ref's local `original` duration metadata before creating the output
artifact and fails fast outside 2–15s. Unknown durations pass through (Kie
stays the authority); slashed refs (`@asset/file.mp4`) are skipped because
artifact metadata does not describe sibling files.

**Ask Apicity:** document the reference clip duration window on the
reference-to-video schema (description at minimum), and confirm whether the
same bound applies to `reference_audio_urls`.

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

## 38. (gap) KIE Qwen 2.1 ships schemas without cost slugs or pricing — OPEN in 0.13.1

`@apicity/kie` 0.13.1 adds `qwen2-1/text-to-image` and
`qwen2-1/image-to-image` (createTask schemas plus `modelInputSchemas`
metadata) but `@apicity/cost` 0.13.1 registers neither a `MODEL_SLUGS.kie`
entry nor a rate for either model, so `modelSlug("kie", "qwen2-1/…")`
throws and `computeEstimate` reports "not found in pricing table".
Videobook ships `generate_kie_qwen_2_1_text_to_image` and
`generate_kie_qwen_2_1_edit_image` (Kie-only routes, labels use the literal
`qwen2-1` slug) with deliberately NO cost adapter: `estimate_cost` returns
$0 plus the "no cost adapter registered" warning, and the kie paygate logs
the unavailable estimate without blocking submission. Add
`kieQwen21*` adapters only when upstream publishes rates; do not invent
per-image goldens. Also note the i2i schema accepts 1-10 reference images
(up from qwen2/qwen3's 1-3) and an optional `mask_url` inpainting field
that the picker deliberately does not surface (`skipKieFields`), matching
the qwen2/qwen3 tools which expose no mask input.

---



| Status       | Sections                                                            | What Videocity still carries                           |
| ------------ | ------------------------------------------------------------------- | ------------------------------------------------------ |
| **OPEN**     | §18 character metadata                                              | list/singleton reconcile                               |
| **OPEN**     | §36 MiniMax H3 reference clip bounds                                | pre-submit 2–15s check from local `original` metadata  |
| **OPEN**     | §38 KIE Qwen 2.1 cost slugs/pricing                                 | no adapter; $0 estimate + warning                      |
| **PARTIAL**  | §14 Flow loose schemas                                              | per-model domains                                      |
| **PARTIAL**  | §15 Flow estimate semantics                                         | local Gemini API list USD (`google-flow-cost.ts`)      |
| **RESOLVED** | §3, §11, §22–24, §26, §28, §30–32, §34–35                          | adopted upstream contracts; local workarounds deleted  |
| **RESOLVED** | §1–2, §4–7, §9–10, §12–13, §16, §19–21, §25, §27, §29              | no local shim (defensive Flow path decode only on §16) |
| **N/A**      | §33 ElevenLabs MCP metadata                                         | `@apicity/mcp-server` not installed                    |

**Deliberate product quirks (not Apicity defects):** §2 Grok external-image-only
`spicy` filter, §8 table, §17 route-specific Flow email resolution, §23
`return_byteplus_urls` not exposed (Videocity ingests via its own CDN path).

**Deferred upstream verification:** §18 appears service-side. §14–15 remain
broader Google Flow product and schema work. One residual upstream nit from the
0.8.8 adoption: `FalEndpointInputMap` keys Qwen edit as `fal-ai/qwen-image-edit`
while the real endpoint is `fal-ai/qwen-image/edit` (§3).

**0.11.0 Wan 3.0 / Qwen 3 update (2026-08-25, vb-2erh):** all Wan 2.x surfaces
are retired (§5, §26, §28 updates above). Wan 3.0 + Prime ship via six fal
tools and two kie omni tools with the kie picker route primary; native
DashScope video is deliberately dropped (§37). Qwen Image 3 edit ships via
`generate_fal_qwen_3_0_edit_image`; like base Wan 3.0 it is upstream
dynamic-pricing, so it has no cost adapter (§26 update).
