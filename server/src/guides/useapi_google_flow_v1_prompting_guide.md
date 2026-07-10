---
source: "useapi.net Google Flow API v1 (https://useapi.net/docs/api-google-flow-v1), fetched 2026-07-09"
type: provider-reference
date_added: 2026-07-09
---

# useapi.net — Google Flow v1 Prompting Reference

Provider documentation for prompts sent through useapi.net's Google Flow API.
This is the authoritative guide for how prompts must be structured for the
Google Flow models (Veo, Gemini Omni Flash, Nano Banana). Use it to rewrite a
user's prompt so it matches the provider's actual request contract.

## Supported models

### Video (`POST /videos`)
- `veo-3.1-fast` (default), `veo-3.1-quality`, `veo-3.1-lite`, `veo-3.1-lite-low-priority` — Veo 3.1, text-to-video & image-to-video.
- `omni-flash` — Gemini Omni Flash, audio-native video: voices, characters, V2V editing, up to 10s.

### Image (`POST /images`)
- `nano-banana-2-lite` (default), `nano-banana-2`, `nano-banana-pro` — Nano Banana / Gemini image models.
- Deprecated aliases still accepted: `nano-banana` → `nano-banana-2`, `imagen-4` → `nano-banana-2-lite`.

## Request contract that shapes the prompt

### `prompt`
- **Required** on both endpoints. A plain text description.
- There is **no documented character/word limit** — do not truncate for length.
- There is **no `negativePrompt` field** on either endpoint. Never emit one.

### `aspectRatio`
- Video (Veo): `landscape` (default), `portrait`, `1:1`, `4:3`, `3:4`.
- Video (omni-flash): `landscape` (default), `portrait` only.
- Image: `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `auto`. `auto` is only valid when at least one reference image is provided (the backend derives the ratio from the first reference).

### `duration` (video only)
- Veo T2V/I2V: `4`, `6`, `8` (default). `4`/`6` are Ultra-only.
- Veo R2V: `8` only.
- omni-flash T2V/R2V: `4`, `6`, `8` (default), `10`.
- omni-flash V2V edit: not accepted — output length matches the input trim window (max 10s).

## Inline `@`-mention markers (the key structured prompting rule)

Markers may be placed inside `prompt` to bind body parameters to positions in
the text. They are **case-insensitive** and **opt-in** — a prompt with no
markers behaves exactly like a plain-text prompt. This is the provider's
canonical way to reference supplied images/characters/audio inline.

### Video markers (`POST /videos`)
- `@character_1..7` → matching `character_N` body param.
- `@referenceImage_1..7` → matching `referenceImage_N` body param.
- `@referenceAudio_1..5` → matching `referenceAudio_N` body param (system voice name or user voice ref).
- `@referenceVideo_*` is **NOT supported inline** — pass `referenceVideo_1` as a body field. The API returns **400** if it appears in `prompt`.

### Image markers (`POST /images`)
- `@character_1..7` → matching `character_N` body param.
- `@reference_1..10` → matching `reference_N` body param. (Note: images use `@reference_N`, videos use `@referenceImage_N`.)

### Rules (both endpoints)
- Each inline marker MUST have a matching body slot supplied, else the API returns **400** (`'character_N' was not provided in the request body`).
- A slot referenced inline still goes into the upstream reference array — markers are positional/grounding info, NOT a replacement for the body params.
- The same slot may be inlined multiple times; the upstream array de-duplicates by id.
- Body params supplied but NOT inlined still flow to the upstream reference array unchanged.
- Unknown strings like `@gmail.com` or `@anyword_1` (no `_<digit>` after a recognized slot name) pass through as literal prompt text.

## Reference budgets (per model)

### Video references
- **Veo (all variants):** start frame `startImage` (I2V), start+end `startImage`+`endImage` (I2V-FL). Image refs `referenceImage_1..3` (max 3, not on `veo-3.1-quality`). Characters `character_1..7` — Veo fast/lite/lite-low-priority only, 8s only, `referenceImages.length + Σ(character.imgs) ≤ 3`. Voice `referenceAudio_1` (1 slot, R2V only, requires an image ref or character; not on `veo-3.1-quality`).
- **omni-flash:** start frame `startImage` only (no end frame). Image refs `referenceImage_1..7` (R2V up to 7 / V2V edit up to 5). Characters `character_1..7` (all durations, `referenceImages.length + Σ(character.imgs) ≤ 7` R2V). Voices `referenceAudio_1..5` (R2V) / up to 3 (V2V edit). Source video `referenceVideo_1` switches to V2V edit mode.

### Image references
- All Nano Banana models support up to **10** reference images (`reference_1..10`) and `character_1..7`. Characters share the same per-model image-ref budget; each character's image count rolls into the total.

## System voice presets (video `referenceAudio_*`)
30 case-insensitive names: Achird, Achernar, Algieba, Algenib, Alnilam, Aoede, Autonoe, Callirrhoe, Charon, Despina, Enceladus, Erinome, Fenrir, Gacrux, Iapetus, Kore, Laomedeia, Leda, Orus, Puck, Pulcherrima, Rasalgethi, Sadachbia, Sadaltager, Schedar, Sulafat, Umbriel, Vindemiatrix, Zephyr, Zubenelgenubi.

## Canonical example prompts (from the provider docs)

- Video T2V (Veo): `"A serene mountain landscape at sunset with camera slowly panning right"`
- Video R2V (omni-flash, @-mentions): `"@character_1 sitting on @referenceImage_1, @character_2 standing beside, @referenceImage_2 visible in the background, smooth camera dolly"`
- Image T2I: `"A serene mountain landscape at sunset with vibrant colors"`
- Image I2I (nano-banana-pro, @-mentions): `"@character_1 standing next to @reference_1, golden hour light"`

## Rewriting guidance

When rewriting a prompt for a Google Flow model:
1. Keep it a single plain-text description. No front-matter, no labels, no key/value pairs.
2. Preserve every `@character_N`, `@referenceImage_N` (video), `@reference_N` (image), and `@referenceAudio_N` marker the user already placed — these bind to supplied references. Do not invent new markers that have no matching body slot (the API returns 400). Use the correct marker vocabulary for the endpoint.
3. Describe the subject, action, setting, camera/lighting/mood concretely and concisely. Cinematic camera language ("slow dolly", "panning right") reads well on Veo.
4. Do not add a negative prompt — the field does not exist.
5. If reference images are supplied but unmentioned, you may weave their `@`-markers into the description to ground them, but never reference a slot that wasn't provided.
6. Respect the model's aspect-ratio and duration vocabulary where the user expressed one; do not invent unsupported values.
