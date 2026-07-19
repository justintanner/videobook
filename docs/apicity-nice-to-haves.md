# @apicity 0.7.3 — executive summary of remaining improvements

**Audience:** whoever owns the `@apicity/*` packages.
**Companion to:** `docs/apicity-gaps.md`, the line-by-line catalog of every
Videocity workaround.

## Current state

Videocity uses `@apicity` as the single source of truth for provider request
contracts and pricing. Its tool schemas, model registry, payloads, jobs, and cost
adapters derive enums, ranges, defaults, string lengths, slot counts, slugs, and
rates from the installed Apicity schemas wherever those contracts are complete.

The 0.7.3 release resolved the largest structural gaps from the prior review:

- every installed package now uses Zod 4;
- request aliases outside Fal describe schema inputs and parsed outputs separately;
- Alibaba exports stable Qwen model and slot schemas plus its video model schema;
- Kie exports the shared HappyHorse duration schema and a corrected conditional
  Grok image-to-video contract;
- `@apicity/x` exposes the authenticated-user endpoint;
- `@apicity/cost` includes HappyHorse 1.1, Seedance 2 Mini, and Gemini Omni.

The remaining work is narrower: make a few permissive or incomplete schemas match
their live endpoints, tighten Google Flow's contract, and repair cost coverage.

## Priority table

| Priority | Ask | Why it matters |
|---|---|---|
| **P0** | Export strict, per-model Google Flow request and response schemas | Loose model unions, shared duration values, and generic responses force Videocity to retain parallel per-model domains and tolerant response readers. |
| **P0** | Complete cost coverage and fix Gemini Omni selectors | Gemini V2V is unpriceable; Google Flow estimates stay local; several Kie and all Fal/xAI/Alibaba media routes lack package estimates. |
| **P1** | Match Fal Seedream 5 Lite and Nano Banana request constraints | Missing enum values, count/seed integer bounds, and edit-reference caps require local contract patches. |
| **P1** | Export Fal model input aliases and an endpoint/input map | Fal's output-typed `*Params` aliases and generic queue input prevent fully typed background payload assembly. |
| **P1** | Add the documented xAI reference-video limits | A seven-image limit and ten-second conditional duration cap currently live only in Videocity validation. |
| **P1** | Repair the xAI Responses search contract | The package advertises a deprecated request path and omits the current search tool contract. |
| **P2** | Align smaller endpoint constraints | Seedance Mini pre-upload references plus ElevenLabs' sound-generation and model-specific TTS text caps need focused schema fixes. |
| **P2** | Preserve raw Google Flow path IDs and normalize email optionality | These transport inconsistencies require a fetch override and account lookup before otherwise ordinary SDK calls. |

## P0 · Strict Google Flow contracts

`@apicity/googleflow` exposes useful request scaffolding, but video and image model
fields still accept arbitrary strings, the shared video duration schema does not
express each model's allowed subset, and job/entity responses remain
`Record<string, unknown>`.

Videocity consequently maintains per-model model/aspect/duration domains, maps
positional reference slots itself, and defensively reads every response shape.

**Ask:** export strict schemas per model and typed job, account, asset, voice, and
character responses. Keep any forward-compatible loose schema as a separate export
rather than combining it with the strict UI-facing contract.

*Catalog refs: `docs/apicity-gaps.md` §14, §17, §18.*

## P0 · Complete and correct cost coverage

The Gemini Omni entry has two selector defects: Kie's string duration falls back to
four seconds in the cost evaluator, and V2V rate keys contain a trailing empty
resolution segment that the generic evaluator removes. Videocity can normalize T2V
durations, but V2V remains unbounded and needs a narrow paygate exception.

Google Flow has no provider, slugs, or rates in `@apicity/cost`, so Videocity keeps
a separate official-rate adapter with Flow credits as metadata.

Two Kie models shipped by the same release, `omnihuman-1-5` and
`volcengine/video-to-video-lip-sync`, have no slugs or rate entries. They retain
literal asset/job slugs, show no estimate, and require a narrow paygate
allowlist. Fal is classified as prohibitive by the shared endpoint policy but
is absent from `EstimateRequest`, so every Fal generation tool also lacks a
package estimate. xAI's cost surface supports token models but not image/video
generation, while Alibaba's media models have partial slug coverage and no
per-unit rates.

**Ask:** accept numeric duration strings, make V2V keys reachable, add the two
missing Kie models, and expose Google Flow and Fal estimates/slugs. If Flow
credits or dynamic Fal prices do not fit the existing USD snapshot model,
represent those estimate sources explicitly. Add endpoint-discriminated xAI
and Alibaba media rates rather than routing those bodies through token
extractors.

*Catalog refs: §15, §21, §25–§28.*

## P1 · Match Fal's published schemas

Seedream 5 Lite omits `auto_4K`, leaves image counts unconstrained, and omits
`return_byteplus_urls`. Nano Banana 2 and Pro likewise leave image counts and seeds
as generic numbers and do not cap edit references, despite Fal publishing integer
counts from one through four, integer seeds, and a fourteen-reference limit.

**Ask:** mirror Fal's published enum, integer, and array constraints in the named
Apicity schemas. Videocity can then delete its remaining local additions while
continuing to derive every other field.

*Catalog refs: §23, §24.*

## P1 · Finish Fal request typing

Most Apicity packages now separate `z.input` request types from parsed
`z.output` types. Fal's per-model `*Params` aliases still use `z.infer`, so
defaulted fields appear required, while the generic queue submission accepts only
an unassociated `Record<string, unknown>`.

**Ask:** export input and parsed aliases for every Fal model request schema and an
endpoint-ID map that connects queue submissions to those input types. Videocity
could then type its background payloads without recreating aliases locally or
falling back to generic records.

*Catalog ref: §3.*

## P1 · Encode xAI's current video and search contracts

The general xAI video schema allows durations from one through fifteen seconds but
does not express the stricter reference-to-video contract: at most seven images and
at most ten seconds when references are present. The Responses schema also retains
deprecated search input and omits the current search-tool shape.

**Ask:** add the reference array cap and a cross-field duration refinement, then
replace the stale Responses search surface with the live tool contract and output
types.

*Catalog refs: §20, §22.*

## P2 · Close focused request and transport gaps

- Seedance 2 Mini's pre-upload reference arrays require public URLs, unlike the
  regular and Fast schemas. A separate local-reference input schema would let SDK
  consumers resolve assets before final URL validation.
- ElevenLabs Sound Generation is missing the endpoint's 450-character text cap.
- ElevenLabs TTS omits model-specific text caps, so one field schema cannot
  validate v3, Multilingual v2, and Flash/Turbo requests correctly.
- Google Flow percent-encodes path IDs whose `:` and `@` characters must remain raw.
- Google Flow requires email on a few entity operations where the service can infer
  the sole configured account.

*Catalog refs: §11, §16, §17, §19, §29.*

## Bottom line

Apicity 0.7.3 removed the broad compatibility layer that dominated the earlier
review. The highest-value next release would make Google Flow strict and
priceable, complete cross-provider media cost coverage, repair Gemini Omni V2V costing, and
align the remaining Fal and xAI schemas with their documented endpoint
contracts.
