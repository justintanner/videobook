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

## 1. (quirk) Mixed Zod major versions across the workspace

`@apicity/kie` resolves **Zod 4** (`node_modules/zod` = 4.3.6) while
`@apicity/alibaba`, `@apicity/xai`, and `@apicity/fal` resolve **Zod 3**
(nested `zod` = 3.25.76). The published `.d.ts` are Zod-4-shaped, but several
packages execute Zod-3 internals at runtime, so reading constraints off a schema
requires handling both layouts:

| | Zod 3 (alibaba/xai/fal) | Zod 4 (kie) |
|---|---|---|
| number int/min/max | `_def.checks[].kind` = `int`/`min`/`max`, flat `value` | `_def.checks[]._zod.def.check` = `number_format`/`greater_than`/`less_than` |
| string min/max len | `_def.minLength.value` / `_def.checks[].kind` | `_def.checks[]._zod.def.check` = `min_length`/`max_length` |
| enum values | `_def.values` (array) | `_def.entries` (object map) |

**Workaround:** the entire dual-version reader in
`server/src/zod-slots.ts` — `enumOptions`, `readSlotConstraints`,
`unwrapToCore`, and the new `zodNumberRange` / `zodStringMaxLength`. Comment at
`zod-slots.ts:1-13` documents it.

**Ask apicity:** unify on a single Zod major across all `@apicity/*` packages,
and make the published `.d.ts` match the runtime.

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

## 4. (gap) No exported Alibaba Qwen image slot / model enums

`@apicity/alibaba` exports no schema for the Qwen multimodal endpoint's
reference-image cardinality (0-3 for generation, 1-3 required for edit), and its
`AlibabaMultimodalGenerationRequestSchema.shape.model` enum **intermixes dated
snapshot ids** (`qwen-image-2.0-pro-2026-03-03`, `qwen-image-edit-plus-2025-12-15`,
…) with stable ids and does not separate generation vs edit models.

**Workaround:** `server/src/image-models.ts:29-36` defines local shims
`AlibabaQwenImageReferenceSlotsSchema`, `AlibabaQwenImageEditReferenceSlotsSchema`,
and the curated `QWEN_GENERATION_MODEL_VALUES` / `QWEN_EDIT_MODEL_VALUES`
(stable-only, split). These are duplicated in
`server/src/tools/generate-alibaba-qwen-image.ts` and `…-edit.ts`.

**Ask apicity:** export `AlibabaQwenImageReferenceSlotsSchema`,
`AlibabaQwenImageEditReferenceSlotsSchema`, and curated stable-only model enums
split by generation vs edit.

---

## 5. (gap) No standalone Alibaba video-model enum

The Alibaba video model list (`["wan2.7-i2v","wan2.7-videoedit"]`) is reachable
only by unwrapping `AlibabaVideoSynthesisRequestSchema` through ~10 `ZodEffects`
layers to `.shape.model`; there is no named `AlibabaVideoSynthesisModelSchema`
export.

**Workaround:** `server/src/video-models.ts` hardcodes
`ALIBABA_VIDEO_MODELS = ["wan2.7-i2v", "wan2.7-videoedit"]`, duplicated in
`server/src/tools/generate-alibaba-video.ts`.

**Ask apicity:** export `AlibabaVideoSynthesisModelSchema`.

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

## 7. (gap) `@apicity/x` exposes no `users/me` endpoint

There is no way to read the authenticated X user's handle programmatically.

**Workaround:** `server/src/watermark-config.ts` keeps a local
`~/.videocity/watermark-config.json` store of previously-used handles. Comment at
`watermark-config.ts:4-6` documents it.

**Ask apicity:** add a `users/me` / `getAuthenticatedUser()` endpoint to
`@apicity/x`.

---

## 8. (bug) FE-vs-apicity value divergences surfaced during the refactor

While wiring apicity as the source of truth, these hand-typed videocity values
were found to **disagree** with the apicity schema. They are left at the
videocity value (it may be a deliberate, provider-correct restriction) and
flagged here for confirmation:

| Where | videocity value | apicity says | Likely reason |
|---|---|---|---|
| `generate_grok_imagine_video.prompt` max length | 4096 | 5000 | unclear — codebase uses 4096 in two places; confirm real endpoint cap |
| `generate_wan27_videoedit_video.duration` | `"0"/2-10` string enum | unbounded `int` | apicity provides no bound; "0 = full source" is provider knowledge |
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
