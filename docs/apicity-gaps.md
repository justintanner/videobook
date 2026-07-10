# @apicity bugs, gaps & quirks that videocity works around

This catalogs every place the videocity server compensates for a **bug, gap, or
packaging quirk** in the `@apicity/*` provider packages. It exists so the work
can be fixed upstream in apicity; the videocity-side workarounds are left **in
place and unchanged** until then.

It is the companion to the "apicity = single source of truth" refactor: where
apicity exposes a *correct* schema, videocity now derives enums / ranges /
defaults from it instead of re-typing them (see `server/src/zod-slots.ts`,
`server/src/video-models.ts`). The items below are the cases where apicity is
**not** usable as-is.

Legend: **bug** = schema/type is wrong or self-inconsistent · **gap** =
something that should be exported isn't · **quirk** = packaging/versioning.

---

## 1. (quirk) ~~Mixed Zod major versions across the workspace~~ — RESOLVED in 0.6.1

**Resolved by `@apicity/* 0.6.1`:** every provider now depends on `zod ^4.4.3`,
so the workspace is unified on **Zod 4** end to end (the app's own zod is 4.3.6;
both are Zod 4 with identical `_def.type` / `_def.checks[]._zod.def` /
`_def.entries` internals). There is no longer any Zod-3 runtime anywhere.

The dual-version readers in `server/src/zod-slots.ts` were collapsed to
**Zod-4-only** (the Zod-3 `_def.typeName` / flat `_def.checks[].kind` /
`_def.minLength.value` / `.options` paths were removed), and the duplicated
union-introspection in `server/src/tools/generate-qwen-image-edit-fal.ts` was
replaced with the shared `zodUnionEnumOptions` helper.

Historical note — under 0.6.0, `@apicity/kie` ran Zod 4 while
`@apicity/alibaba`/`xai`/`fal` ran nested Zod 3 (3.25.76) despite Zod-4-shaped
`.d.ts`; reading constraints required handling both layouts.

---

## 2. (bug) grok image-to-video `mode` enum includes `"spicy"`; `aspect_ratio` includes `"auto"`

`GrokImageToVideoRequestSchema.shape.input.shape.mode` is the full
`["fun","normal","spicy"]` enum, but the Kie grok **image-to-video** endpoint
rejects `"spicy"` (only **text**-to-video accepts it). The `aspect_ratio` enum
similarly includes `"auto"`, which the i2v endpoint does not honor.

**Workaround:**
- `server/src/video-models.ts` — `GROK_IMAGE_TO_VIDEO_MODES = GROK_IMAGINE_MODES.filter(m => m !== "spicy")`, and `generate_grok_imagine_video.mode` is listed in `APICITY_DERIVE_SKIP` so it is **not** auto-derived from the apicity enum.
- `applyVideoToolConstraints()` maps `mode === "spicy" → "normal"` and `aspect_ratio === "auto" → "16:9"` at submit time.
- `server/src/payload-builders.ts` (~`buildGrokImagineVideoPayload`) maps `spicy → normal`.

**Ask apicity:** split the grok mode enum into i2v (`fun`/`normal`) vs t2v
(`fun`/`normal`/`spicy`) variants, and drop `"auto"` from the i2v aspect_ratio
enum (or document that the endpoint silently remaps it).

---

## 3. (gap) Request types are `z.infer` (output) only — no `z.input` / `*Input` exports

Every apicity request type is `z.infer<typeof Schema>` (i.e. **z.output**).
Because fields use `.default(...)`, those fields become **required** in the
output type, so an assembled *partial* payload (the common case — let the
provider fill defaults) does not type-check against the request type.

**Workaround:** the `as <Type>["input"]` and `as unknown as Record<string, unknown>`
casts throughout `server/src/payload-builders.ts`, plus the `valueOrZodDefault()`
helper that exists only to read apicity defaults the output type doesn't surface
ergonomically. Origin documented in commit `7d5282d`: *"…making
nsfw_checker/aspect_ratio/resolution required in the output type. Cast assembled
inputs to the request input type (same wire bytes; the provider fills
defaults)."*

> Per the agreed scope this is **reported only** — the casts are intentionally
> left as-is rather than re-plumbed through locally-derived `z.input<>` aliases.

**Ask apicity:** export an input-typed alias per request, e.g.
`export type GrokImageToVideoRequestInput = z.input<typeof GrokImageToVideoRequestSchema>`.

---

## 4. (gap) ~~No exported Alibaba Qwen image slot enums~~ — RESOLVED; model-enum part PARTIAL

**Slot schemas — RESOLVED (≤0.6.2):** `@apicity/alibaba` now exports
`AlibabaQwenImageGenerationImageSlotsSchema` (`.max(3)`) and
`AlibabaQwenImageEditImageSlotsSchema` (`.min(1).max(3)`), matching the reference
cardinality exactly. The local shims `AlibabaQwenImageReferenceSlotsSchema` /
`AlibabaQwenImageEditReferenceSlotsSchema` in `server/src/image-models.ts` were
deleted and replaced with the apicity imports.

**Model enums — PARTIAL:** apicity now also exports
`AlibabaQwenImageGenerationModelSchema` / `AlibabaQwenImageEditModelSchema`
(split generation vs edit — good), but they **still intermix dated snapshot ids**
(`qwen-image-2.0-pro-2026-03-03`, `qwen-image-edit-plus-2025-12-15`, …) with the
stable ids. videocity keeps the curated stable-only `QWEN_GENERATION_MODEL_VALUES`
/ `QWEN_EDIT_MODEL_VALUES` in `server/src/image-models.ts` as a **deliberate
divergence** (we expose stable ids only to MCP clients).

**Ask apicity:** offer stable-only variants of the Qwen image model enums (or a
flag to exclude dated snapshots), so the curated lists can be derived too.

---

## 5. (gap) ~~No standalone Alibaba video-model enum~~ — RESOLVED (≤0.6.2)

**Resolved:** `@apicity/alibaba` now exports `AlibabaVideoSynthesisModelSchema`
(`z.enum(["wan2.7-i2v", "wan2.7-videoedit"])`). The hardcoded `ALIBABA_VIDEO_MODELS`
in `server/src/video-models.ts` and `server/src/tools/generate-alibaba-video.ts`
were replaced with `enumOptions(AlibabaVideoSynthesisModelSchema)` /
`z.enum(AlibabaVideoSynthesisModelSchema.options)` respectively.

---

## 6. (gap) No exported HappyHorse duration schema

HappyHorse request schemas type `duration` as a bare `z.number().int().min(3).max(15)`
on each request (no shared, named `HappyHorseDurationSchema`). This is now
*derivable* (videocity expands the numeric range into the `"3".."15"` string
enum), but a named export would be cleaner and explicit.

**Workaround:** previously a hardcoded `HAPPYHORSE_DURATIONS` array (now removed —
derived from the per-request `duration` field).

**Ask apicity:** export a shared `HappyHorseDurationSchema`.

---

## 7. (gap) ~~`@apicity/x` exposes no `users/me` endpoint~~ — RESOLVED in 0.7.0

**Resolved by `@apicity/x@0.7.0`:** the provider now exposes
`x.get.v2.users.me()` (`XUsersMeMethod`), returning `{ data: { id, name, username, ... } }`.
The watermark dialog reads the authenticated handle live via
`server/src/x/authenticated-handle.ts` → `fetchAuthenticatedXHandle()`, with a
read-through cache in `watermark-config.ts` (`authenticatedHandle` field) so the
dialog still pre-fills when the API is unreachable. The local
`~/.videocity/watermark-config.json` store remains for explicit user preferences
(`savedHandle`, `recent`) and as the fallback cache.

---

## 8. (bug) FE-vs-apicity value divergences surfaced during the refactor

While wiring apicity as the source of truth, these hand-typed videocity values
were found to **disagree** with the apicity schema. They are left at the
videocity value (it may be a deliberate, provider-correct restriction) and
flagged here for confirmation:

| Where | videocity value | apicity says | Likely reason |
|---|---|---|---|
| `generate_grok_imagine_video.prompt` max length | 4096 | 5000 | unclear — codebase uses 4096 in two places; confirm real endpoint cap |
| `generate_wan27_videoedit_video.duration` | `"0"/2-10` string enum | `Wan27VideoEditDurationSchema` (0-10 int + refine excluding 1) | bound now exported; refine excluding 1 is not introspectable by `zodNumberRange` (opaque custom check), so derive-skip stays |
| `generate_wan27_r2v_fal_video.duration` | int `2-10` | int `0-10` | r2v has no source clip, so `0` (full-source) is intentionally excluded |
| `generate_grok_imagine_ref_video.duration` | `6`/`10` (kie enum) | unbounded number (xAI schema) | xAI schema is loose; real endpoint only accepts 6 or 10 |

Each is encoded in `APICITY_DERIVE_SKIP` (`server/src/video-models.ts`) with an
inline comment. **Action:** confirm whether the videocity value or the apicity
value is correct for each, and fix whichever is wrong.

---

### Notes for the apicity-correct changes this refactor *did* make

Deriving from apicity surfaced validation the FE was silently missing. These are
**new, apicity-backed** constraints now applied (not regressions):

- `generate_wan27_t2v_fal_video` / `generate_wan27_i2v_fal_video`: aspect_ratio /
  resolution / duration now carry the apicity enums (previously free-text).
- `generate_omnihuman_video.seed` (min `-1`) and `generate_alibaba_video.seed`
  (`0`–`2147483647`) now carry apicity's numeric bounds.

---

## 9. (gap) ~~`@apicity/cost@0.6.0` has no slugs/pricing for HappyHorse 1.1~~ — RESOLVED in 0.6.1

**Resolved by `@apicity/cost@0.6.1`:** it now prices the **HappyHorse 1.1**
endpoints (`happyhorse-1-1/{text,image,reference}-to-video`) directly —
`modelSlug` resolves and `computeEstimate` returns a bounded estimate with no
warnings.

Note the 1.1 rates **differ** from 1.0 (1.1 is `$0.165`/`$0.22` per second by
resolution vs 1.0's `$0.155`/`$0.265`), so the prior cost-display borrow of the
1.0 slugs **over-charged** at 1080p. Fixes applied:

- **Cost display** (`server/src/cost-adapters.ts`) now keys t2v/i2v/ref off the
  actual `happyhorse-1-1/*` slugs. `video-edit` stays on 1.0
  (`happyhorse/video-edit` — no 1.1 video-edit endpoint exists).
- The three `happyhorse-1-1/*` entries were removed from
  `COST_TABLE_PENDING_MODELS` (`server/src/jobs/kie-paygate.ts`) — admitted via
  real pricing now.
- Generation payloads already targeted `happyhorse-1-1/*`; unchanged.

---

## 10. (gap) ~~`@apicity/cost@0.6.0` has no slug/pricing for Seedance 2 Mini~~ — RESOLVED in 0.6.1

**Resolved by `@apicity/cost@0.6.1`:** it now registers a `bytedance/seedance-2-mini`
slug (`"sd2m"`) and per-second pricing (resolution-tiered, 480p/720p — the only
tiers the tool exposes). Fixes applied:

- **Cost display** (`server/src/cost-adapters.ts`) gained a
  `generate_seedance2_mini_video: kieResolutionVideo("bytedance/seedance-2-mini", "720p")`
  entry — the UI now shows a real number instead of `—`.
- Asset/job **naming** switched from the literal `"seedance2mini"` to
  `modelSlug("kie", "bytedance/seedance-2-mini")` (`server/src/tools/generate-seedance2-mini-video.ts`),
  matching the sibling fast/regular tools.
- The `bytedance/seedance-2-mini` entry was removed from
  `COST_TABLE_PENDING_MODELS` (`server/src/jobs/kie-paygate.ts`).
- Still reuses the shared `seedance2_video` TaskType + `completeSeedance2Video`
  handler; the exact model rides in `meta.apiModel`.

---

## 11. (bug) Seedance 2 Mini reference arrays enforce `.url()`; regular/fast use plain `z.string()` — FIXED upstream in 0.6.1

**Fixed by `@apicity/kie@0.6.1`:** `Seedance2MiniInputSchema`'s `reference_*_urls`
are now plain `z.array(z.string())` (no `.url()`), matching the regular/fast
schemas. The slug-friendly `refSlugCheck` workaround below is therefore
**redundant** — it still passes harmlessly and is left in place for now; a
follow-up can drop it and validate the slug arrays directly against
`Seedance2MiniRequestSchema`. (The new `generate_gemini_omni_video` tool relies
on this same loosening: its `image_urls` / `video_list[].url` are plain
`z.string()`, so it validates `@slug`s against the full request schema with no
mirror — see §13.)

Original report (0.6.0):

`Seedance2MiniInputSchema` validates all three reference arrays with
`z.array(z.string().url())`:

```js
reference_image_urls: z.array(z.string().url()).default([]),
reference_video_urls: z.array(z.string().url()).max(3).default([]),
reference_audio_urls: z.array(z.string().url()).max(3).default([]),
```

But the sibling `Seedance2InputSchema` (regular) and `Seedance2FastInputSchema`
use plain `z.array(z.string())` for the same fields. videocity tools validate
the *request shape* against these schemas **before** resolving references — at
which point reference fields hold `@slug` / `@plan/<file>` addresses, not URLs
(the job uploads them to real Kie URLs via `uploadAssetToKie` just before
submit). The lax regular/fast schemas tolerate slugs; the Mini schema's `.url()`
rejects every slug with `Invalid URL`, so `generate_seedance2_mini_video`
returned an error for every call carrying references — surfacing as
`[SCENE N FAILED]` in the char_swap flow once Mini became its default model.

**Workaround (`server/src/tools/generate-seedance2-mini-video.ts`):** validate
the incoming slug arrays against a slug-friendly mirror
(`z.array(z.string())` + the apicity max counts) and **omit** `reference_*_urls`
from the `Seedance2MiniRequestSchema.safeParse` pre-check. Everything else
(prompt length, duration range, enums) is still validated against apicity; the
slugs are validated for existence/type by `resolveImageSlug` /
`resolveVideoSlug` / `resolveAudioSlug` and uploaded to real URLs in the job.

**Ask apicity:** make the Seedance 2 Mini reference arrays consistent with the
regular/fast schemas (plain `z.string()`), or expose a separate slot for
pre-upload validation. The `.url()` constraint is only correct at the live REST
boundary, not at the SDK's request-construction layer.

---

## 12. (gap) `@apicity/cost@0.6.1` has no slug/pricing for Gemini Omni Video

`@apicity/kie@0.6.1` ships the new **Gemini Omni Video** endpoint
(`gemini-omni-video`) — zod, types, `model-schemas` — but `@apicity/cost@0.6.1`
prices no `gemini-omni-video` rate. So `modelSlug("kie", "gemini-omni-video")`
throws and `computeEstimate` returns `$0` + a `not found in pricing table`
warning. Same shape as the (now-resolved) §10.

**Workaround (`generate_gemini_omni_video`):**

- Asset/job **naming** uses a literal `SLUG = "gemini-omni"` in
  `server/src/tools/generate-gemini-omni-video.ts` (modelSlug would throw).
- **Cost display**: intentionally *no* `cost-adapters.ts` entry → the UI shows
  `—` (honest "no rate available").
- The **paygate** admits `gemini-omni-video` via `COST_TABLE_PENDING_MODELS` in
  `server/src/jobs/kie-paygate.ts`.
- Reuses the shared `seedance2_video` TaskType + `completeSeedance2Video`
  handler; the exact model rides in `meta.apiModel`.

**Ask apicity:** add a `gemini-omni-video` slug + pricing to `@apicity/cost`.
Remove the naming/paygate workarounds and wire a `cost-adapters.ts` entry once
priced.

---

## 13. (gap) No `gemini-omni-audio` / `gemini-omni-character` create flow wired

`gemini-omni-video`'s input accepts `audio_ids` (≤3) and `character_ids` (≤3)
that reference assets minted by **separate create endpoints**:

- `gemini-omni-audio` exists in `@apicity/kie@0.6.1` as
  `kie.post.api.v1.omni.audio.create` (`GeminiOmniAudioCreateRequestSchema`, a
  voice picked from 30 named voices) — but videocity has no asset-creation flow
  for "mint an ID, then reference it later", so it is **not** wired.
- `gemini-omni-character` has **no apicity endpoint at all** — it's only
  referenced by ID in the video schema's description, with no create
  method/schema to produce those IDs.

**Workaround (`server/src/tools/generate-gemini-omni-video.ts` +
`payload-builders.ts`):** `audio_ids` and `character_ids` are **omitted** from
the tool's input schema and payload. Both are optional upstream, so omitting them
keeps requests valid; the model still runs from prompt + reference images +
reference video clip.

**Ask apicity:** (a) add a `gemini-omni-character` create endpoint so character
IDs can be produced; (b) once both create flows exist, videocity can add an
audio/character asset-minting flow and surface `audio_ids` / `character_ids`.

**Note:** the **Google Flow** (`omni-flash`) side of this *is* now wired — its
`referenceAudio_1..5` (voices) and `character_1..7` refs are minted by the
`create_google_flow_voice` / `create_google_flow_character` tools and surfaced on
`generate_google_omni_video` as `voice_refs` / `character_refs`. Only the
kie-proxied `gemini-omni-video` side remains unwired (no create flow there).

---

## 14. (gap) `@apicity/googleflow` schemas carry reference slots but weak enums and no response types — PARTIALLY RESOLVED in 0.7.2

The google-flow endpoints moved to a dedicated `@apicity/googleflow` package
in 0.7.1 (split out of `@apicity/google`, which now hosts only Vertex
express-mode / Gemini content calls — the `@apicity/google@0.7.1` Flow removal
is resolved by the split provider). `@apicity/googleflow@0.7.1`'s request
schemas (`GoogleFlowImagesRequestSchema`, `GoogleFlowVideosRequestSchema`)
**do** type the positional reference fields as named optional strings —
`startImage`, `endImage`, `referenceImage_1..7`, `reference_1..10`,
`referenceVideo_1`, `startFrameIndex_1`/`endFrameIndex_1`, `character_1..7`,
`referenceAudio_1..5`.

**0.7.2 tightened some fields but not enough to derive from:**
- `videos.model` / `videos.aspectRatio` / `images.model` gained
  `z.enum([...]).or(z.string())` — still **loose** (arbitrary strings accepted),
  so `zodEnumOptionsOrNull` reads nothing, and deriving `aspectRatio` would
  clobber the app-side ratio-string → `landscape`/`portrait` mapping anyway.
- `videos.duration` **tightened to `z.union([literal(4), literal(6), literal(8),
  literal(10)])`** — a numeric-literal union, not a derivable enum-of-strings. The
  app keeps duration as a string enum per tool and converts via the
  `GOOGLE_FLOW_DURATION_SECONDS` map in `payload-builders.ts`.
- `videos.startFrameIndex_1` / `endFrameIndex_1` gained int ranges (0-239 / 1-240);
  the omni payload builder already clamps to exactly that.
- `images.aspectRatio` became a **strict** enum (`16:9/4:3/1:1/3:4/9:16/auto/
  landscape/portrait`); the app only ever sends the first six.
- New `GoogleFlowVoicePresetSchema` (30 named presets) — exported **only from the
  `@apicity/googleflow/zod` subpath**, not the package root — is consumed via
  `apicityField` in `create_google_flow_voice`.
- `videos.trimStart`/`trimEnd` were **removed** from the exported type (the app
  never used them; omni trims via the frame-index fields).

Still weak: `seed`/`count` remain plain optional numbers, the loose model/aspect
enums can't be derived, and **every response is still
`GoogleFlowResponse = Record<string, unknown>`** (see the tolerant readers in
`server/src/jobs/_google-flow.ts` and `server/src/tools/_google-flow-entities.ts`).

**Workaround (`generate_veo31_*`, `generate_google_omni_video`,
`generate_nano_banana_pro_google`):**

- Tool schemas and the `getVideoToolSchema` per-tool blocks in
  `server/src/video-models.ts` hand-type the allowed values from the
  useapi.net Google Flow docs (video models `veo-3.1-quality/-fast/-lite`,
  `omni-flash`; image model `nano-banana-pro`; video aspect
  `landscape`/`portrait`/`1:1`/`4:3`/`3:4`; veo durations 4/6/8; omni
  durations 4/6/8/10; image aspect `16:9`/`4:3`/`1:1`/`3:4`/`9:16`/`auto`).
- These tools are intentionally **not** registered in
  `VIDEO_PARAM_ZOD_SCHEMAS` — there is nothing to derive, and deriving later
  would clobber the app-side ratio-string → `landscape`/`portrait` mapping in
  `payload-builders.ts` (`googleFlowVideoAspect`).
- Reference assets are spread into the named `referenceImage_N` /
  `reference_N` keys by `googleFlowReferenceSlots` in `payload-builders.ts`;
  image-slot limits are hand-set in `IMAGE_SLOT_OVERRIDES`.
- The nested asset-upload response (`mediaGenerationId.mediaGenerationId`) is
  unwrapped defensively in `server/src/jobs/_google-flow.ts`.

**Ask apicity:** make the loose `model`/`aspectRatio` enums strict (drop the
`.or(z.string())`), and add a `GoogleFlowVideosResponse` / `GoogleFlowJobResponse`
/ `GoogleFlowVoiceResponse` / `GoogleFlowCharacterResponse` shape — today every
response is still `GoogleFlowResponse = Record<string, unknown>`, which is why
the voices/characters/accounts tools ship hand-written tolerant readers.

---

## 15. (gap) `@apicity/cost` has no `google` provider — Google Flow models unpriced

`@apicity/cost@0.7.1`'s `PRICING` covers `openai, anthropic, xai, kimicoding,
fireworks, alibaba, elevenlabs, kie` — no `google`. useapi.net bills Google
Flow in plan credits (veo-3.1-quality 100, -fast 20/10, -lite 10/5,
omni-flash 15–40 per clip), not USD, so `modelSlug("google", …)` throws and
no estimate is possible via `@apicity/cost`.

**Workaround (`generate_veo31_*`, `generate_google_omni_video`,
`generate_nano_banana_pro_google`):**

- **No `cost-adapters.ts` entries** (apicity cannot price these).
- **Local cost table** in `server/src/google-flow-cost.ts`, called from
  `estimate_cost` before the adapter path. Badge **USD** uses official Gemini
  Developer API list rates (Omni/Veo $/s @ 720p, Nano Banana Pro $/image) —
  **not** credits × subscription amortization. Flow **credits** are secondary
  (`breakdown.credits` + tooltip); `GOOGLE_FLOW_PLAN_TIER` (default ultra99)
  only affects Lite/Fast credit counts and tooltip copy.
- Asset/job **naming** uses literal slugs (`veo31`, `veo31-fast`,
  `veo31-lite`, `google-omni`; the image tool borrows the kie
  `nano-banana-pro` slug `nbp` for cross-provider consistency).
- No paygate involvement — the kie OTP paygate does not apply to google-flow
  requests.

**Ask apicity:** add a `google`/`googleflow` provider to `@apicity/cost` with
credits-based rates (or a credits→USD conversion) for the google-flow
models, plus `MODEL_SLUGS.google` entries — then drop the local table.

---

## 16. (bug) `@apicity/googleflow` percent-encodes path IDs — useapi.net requires them raw

`@apicity/googleflow@0.7.1` **and 0.7.2** (still unfixed — re-verify on each
upgrade; the `google.js` URL builders are byte-identical between the two) build
their GET/DELETE path segments with `encodeURIComponent` (`google.js`:
`jobs.retrieve`, `assets.retrieve`, `accounts.retrieve`, `characters.retrieve`,
`voices.retrieve`, and the DELETE-by-ref routes). useapi.net IDs
carry `:` and `@` — e.g. a job id is
`j0707051013179185608v-u2935-email:justinwtanner@gmail.com-bot:google-flow` —
and the server expects them **RAW**: an encoded job id returns
`400 Invalid job ID format`. Confirmed by direct probe (raw unencoded `fetch`
→ `200`; package `provider.get.v1.jobs.retrieve` → `400`).

**Workaround (`server/src/jobs/_google-flow.ts`):** a `googleFlowFetch` hook
passed via `createGoogleFlow({ fetch })` (the provider's sanctioned fetch
override) decodes the over-encoded pathname back to raw before the request
leaves the process. Wired into both provider construction sites
(`createGoogleFlowProvider` and the `sync.ts` poll branch). POST endpoints are
unaffected (the job id travels in the response body, not the path), so submit
and asset upload worked without it; `jobs.retrieve` polling broke, and the same
hook now also covers the `voices`/`characters` GET-list-item and DELETE-by-ref
paths (their refs carry `:`/`@` too).

**Ask apicity:** stop `encodeURIComponent`-ing path IDs (or use an encoding
that preserves `:` / `@`, which useapi.net accepts verbatim). Note
`assets.retrieve` (`mediaGenerationId`) carries `:` too, so it would break the
same way if ever wired.

---

## 17. (gap) `@apicity/googleflow@0.7.2` requires `email` on voices create/list and characters list — useapi.net defaults it

`GoogleFlowVoicesCreateRequestSchema`, `GoogleFlowVoicesListRequestSchema`, and
`GoogleFlowCharactersListRequestSchema` all declare `email: z.string()`
(**required**), so the provider's client-side `safeParse` throws a 400 before the
request leaves the process if `email` is omitted. But useapi.net treats `email`
as optional — it defaults to the single configured account — and the omni
**generation** endpoints (`videos`, `images`, `assets`, `characters` *create*)
correctly leave `email` optional. The asymmetry is inconsistent: `characters`
create has no `email` field at all, yet `characters` list requires it.

**Workaround (`server/src/tools/_google-flow-entities.ts`):**
`resolveGoogleFlowEmail(provider, explicit?)` — an explicit `email` wins;
otherwise it calls `GET /accounts` and uses the sole configured account (erroring
with the account list when zero or several exist). The voice/character list and
voice create tools resolve `email` this way before calling the provider, so the
common single-account case needs no `email` argument.

**Ask apicity:** make `email` optional on `voices` create/list and `characters`
list (matching the generation endpoints and useapi.net's own default-account
behavior).
