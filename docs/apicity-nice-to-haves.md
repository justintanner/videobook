# @apicity 0.6.0 — exec summary of nice-to-haves

**Audience:** whoever owns the `@apicity/*` packages.
**Companion to:** `docs/apicity-gaps.md` (the line-by-line catalog of every workaround).

## Thesis

videocity uses `@apicity` as the **single source of truth** for generation params —
enums, ranges, defaults, and pricing are *derived* from apicity Zod schemas, not
hand-typed (see `server/src/zod-slots.ts`, `server/src/video-models.ts`,
`server/src/cost-adapters.ts`). That design works well where apicity ships a
**correct, named, version-consistent** schema. Every workaround in the codebase is
a place where it doesn't.

The workarounds cluster into four themes. **Two of them account for the bulk of the
workaround code and the only *recurring* tax** — fix those two and most of the rest
are one-off cleanups.

## Priority table

| # | Ask | Theme | Why it's worth it |
|---|-----|-------|-------------------|
| **P0** | Ship `@apicity/cost` in **lockstep** with `@apicity/kie` (slugs + pricing for every model the kie package adds) | Cost lags kie | Recurring tax: **every new model** needs a paygate shim. Bit us twice in 0.6.0 alone. |
| **P0** | Unify on **one Zod major** across all `@apicity/*` packages; make published `.d.ts` match runtime | Versioning | Eliminates the single largest body of workaround code (~360-line dual-version reader). |
| **P1** | Export `z.input<>`-typed request aliases (`*RequestInput`) | Type ergonomics | Removes casts from **every** payload builder. |
| **P1** | Export the **missing named enums/slot schemas** (Qwen, Alibaba video, HappyHorse duration) | Derivability gaps | Deletes hardcoded enums duplicated across 3–5 files each. |
| **P2** | Fix the **grok i2v `mode`/`aspect_ratio`** enums (drop `spicy`/`auto` for i2v) | Schema bug | Removes an `APICITY_DERIVE_SKIP` + two remap sites. |
| **P2** | Confirm 4 **FE-vs-apicity value divergences**; add a `users/me` to `@apicity/x` | Correctness | Lets videocity stop guessing which side is right. |

---

## P0 · `@apicity/cost` must track `@apicity/kie`

**This is the freshest and most repetitive pain.** In 0.6.0, `@apicity/kie` shipped
three HappyHorse 1.1 endpoints and `bytedance/seedance-2-mini` with full Zod + types
+ `model-schemas` — but `@apicity/cost@0.6.0` priced **none** of them. The fallout in
videocity, *per new model*:

- `modelSlug("kie", <new-model>)` **throws** → forced to hardcode a literal slug for
  asset/job naming (`SLUG = "seedance2mini"`; the 3 HappyHorse tools borrow the 1.0
  `"hh"` slug).
- `computeEstimate` returns `$0` + a "not found in pricing table" warning, which
  `mintKieOtp` treats as unbounded and **rejects** → forced to maintain a
  `COST_TABLE_PENDING_MODELS` allowlist in `server/src/jobs/kie-paygate.ts` (now **6
  entries and growing**).
- Cost **display** has no rate → either borrow a priced sibling's rate (HappyHorse
  1.1 reuses the identical 1.0 per-second rates) or honestly show `—` (Seedance Mini
  has no sibling).

**The structural problem:** `kie` and `cost` are versioned and released
independently, so a `kie` minor can introduce a model that `cost` of the same version
can't price. **Ask:** treat the pricing table as part of the model's definition —
when `kie` adds a model, `cost` ships its slug + rate in the same release. Bonus: a
`modelSlug(provider, model, { fallback })` overload (or a non-throwing
`tryModelSlug`) would remove the literal-slug workaround even during the lag window.

*Catalog refs: `docs/apicity-gaps.md` §9, §10.*

---

## P0 · One Zod major, types that match runtime

`@apicity/kie` resolves **Zod 4**; `@apicity/alibaba`, `@apicity/xai`, `@apicity/fal`
resolve **Zod 3**. Worse, the **published `.d.ts` are Zod-4-shaped while the runtime
executes Zod-3 internals** for several packages — and runtime constraint metadata
(`.min/.max/.int`, string lengths) is **erased from the `.d.ts` *and* omitted from the
JSON `modelInputSchemas` registry**, so the only way to read a duration range or a
prompt max-length is to crack open the live schema object.

**Workaround:** the entire dual-layout reader in `server/src/zod-slots.ts` — every
constraint reader (`zodNumberRange`, `zodStringMaxLength`, `enumOptions`,
`readSlotConstraints`, …) carries two code paths (Zod 3 flat `_def.checks[].kind`
vs Zod 4 nested `_def.checks[]._zod.def.check`; enum `_def.values` array vs
`_def.entries` map). ~360 lines that exist **only** to paper over the version split.

**Ask:** (1) pin all `@apicity/*` to a single Zod major; (2) ensure the published
types match the runtime; (3) ideally, surface constraints in the JSON registry too so
consumers don't have to introspect `_def` at all.

*Catalog ref: §1.*

---

## P1 · Input-typed request aliases

Every apicity request type is `z.infer<Schema>` (i.e. **z.output**). Because fields
use `.default(...)`, those fields are **required in the output type** — so an
assembled *partial* payload (the normal case: let the provider fill defaults) does
not type-check against the request type.

**Workaround:** `as <Type>["input"]` / `as unknown as Record<string, unknown>` casts
in **every builder** in `server/src/payload-builders.ts`, plus a `valueOrZodDefault()`
helper that exists only to read defaults the output type hides.

**Ask:** export an input alias per request:
`export type GrokImageToVideoRequestInput = z.input<typeof GrokImageToVideoRequestSchema>`.

*Catalog ref: §3.*

---

## P1 · Missing named enums & slot schemas

apicity hides several enums behind deep unwrapping or doesn't export them at all,
forcing videocity to hardcode (and duplicate) the values:

- **Qwen image** (§4): no reference-image slot schema, and the model enum
  **intermixes dated snapshot ids** (`qwen-image-2.0-pro-2026-03-03`, …) with stable
  ids and doesn't split generation vs edit. → local `QWEN_*_MODEL_VALUES` shims
  duplicated across `image-models.ts` + two tool files.
- **Alibaba video** (§5): the model list is reachable only by unwrapping ~10
  `ZodEffects` layers; no named `AlibabaVideoSynthesisModelSchema`. → hardcoded
  `ALIBABA_VIDEO_MODELS`, duplicated.
- **HappyHorse duration** (§6): typed as a bare inline `z.number().int().min(3).max(15)`
  on each request; no shared `HappyHorseDurationSchema`.

**Ask:** export curated, **stable-only**, generation-vs-edit-split model enums; export
reference-slot schemas; export shared scalar schemas (duration). Keep dated snapshot
ids out of the default enum.

*Catalog refs: §4, §5, §6.*

---

## P2 · Schema-correctness bugs to confirm/fix

- **grok image-to-video** (§2): `mode` enum includes `"spicy"` and `aspect_ratio`
  includes `"auto"`, but the **i2v** endpoint rejects both (they're text-to-video
  only). videocity filters `spicy` out and remaps `spicy→normal` / `auto→16:9` at
  submit time. **Ask:** split the mode enum into i2v (`fun`/`normal`) vs t2v
  (`fun`/`normal`/`spicy`) and drop `auto` from i2v `aspect_ratio`.
- **4 FE-vs-apicity divergences** (§8): grok prompt max (4096 vs 5000), wan27
  videoedit duration (`"0"/2–10` vs unbounded), wan27 r2v duration (`2–10` vs
  `0–10`), grok ref duration (`6/10` vs unbounded). Each sits in
  `APICITY_DERIVE_SKIP` awaiting a "which side is correct?" answer. **Ask:** confirm
  the real endpoint caps so videocity can stop diverging.
- **`@apicity/x` `users/me`** (§7): no way to read the authenticated handle → local
  `~/.videocity/watermark-config.json` cache. **Ask:** add `getAuthenticatedUser()`.

*Catalog refs: §2, §7, §8.*

---

## TL;DR

If only two things ship: **(1) keep `@apicity/cost` priced in lockstep with
`@apicity/kie`**, and **(2) unify the Zod major + match published types to runtime**.
Those two erase the recurring cost-shim tax and the largest single block of
introspection code; everything else is a finite list of named exports and enum fixes.
