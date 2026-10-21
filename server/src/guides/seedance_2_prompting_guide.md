---
source: "fal.ai/models/bytedance/seedance-2.0/reference-to-video, seedance2api.app/blog/seedance-2-prompt-guide, seed.bytedance.com/en/blog/official-launch-of-seedance-2-0"
type: reference
date_added: 2026-05-03
---

# Seedance 2.0 Prompting Guide

## Summary

Seedance 2.0 is ByteDance's multimodal video generation model. It uses a dual-branch Diffusion Transformer — one branch for spatial information (what things look like), one for temporal (how they move). Well-structured prompts feed both branches cleanly. The model exposes director-level camera control via prompt (dolly, tracking, POV switches, handheld) and generates synchronized native audio by default.

Three task variants share the same prompt grammar:
- **t2v** (text-to-video) — prompt only
- **i2v** (image-to-video) — prompt + a single first-frame image (and optional `end_image_url` last frame)
- **r2v** (reference-to-video) — prompt + up to 9 images, 3 videos, 3 audio clips (12 files max), referenced by @-tag in the prompt

A "fast" mode exists for each variant — same schema, lower quality/latency tradeoff.

## Prompt Structure

Five-component formula:

**Subject + Action + Camera + Style + Constraints**

- **Subject** — who/what appears
- **Action** — movement and events
- **Camera** — angle, movement, lens
- **Style** — aesthetic anchor (specific film/director, not "cinematic")
- **Constraints** — duration, resolution, physics requirements

Keep prompts under ~150 words. Place subject and action first.

## @ Tag Reference Syntax (r2v)

Reference uploaded files inline using `@Image1`, `@Video1`, `@Audio1`. Numbers correspond to upload order. `generate_video` in `r2v` mode accepts `refs.image` / `refs.video` / `refs.audio` arrays of artifact ids — index 0 is `@Image1`, index 1 is `@Image2`, etc.

Limits per request:
- Images: `@Image1` … `@Image9` (max 9)
- Videos: `@Video1` … `@Video3` (max 3, combined 2–15s)
- Audio: `@Audio1` … `@Audio3` (max 3, combined ≤15s)
- Total files across modalities: 12

### Image reference roles

State the role explicitly so the model knows what to do with each image:

- `@Image1 as the first frame` — start the video from this image
- `@Image1 as the last frame` — end the video at this image
- `@Image1 as character reference` — preserve appearance throughout
- `@Image1 as background environment` — use as scene setting
- `@Image1 as style reference` — match color/texture/mood

### Video reference roles

- `Refer to the camera movement of @Video1`
- `Character moves like @Video1` — transfer choreography
- `Apply the transition effects from @Video1`
- `Match the pacing and cuts of @Video1`

### Audio reference roles

- `@Audio1 as background soundtrack`
- `@Audio1 as ambient sound`
- `@Audio1 as voice style reference`

### Worked example (multi-modal r2v)

```
Replace the character in @Video1 with @Image1, with @Image1 as the first frame.
The character should wear virtual sci-fi glasses. Refer to the camera movement
and close-up surround shots of @Video1, changing from a third-person perspective
to the character's subjective perspective. Travel through AI virtual glasses and
arrive at the deep blue universe of @Image2 where several spaceships are seen
traveling into distance.
```

This prompt works because every @-tag has an explicit role (`replace … with`, `as the first frame`, `Refer to … of`, `arrive at … of`), the perspective shift is named (third-person → subjective), and the destination scene is anchored visually (`deep blue universe … spaceships`).

### Actor replacement (video source + still identity refs)

Use Seedance 2.0 reference-to-video when replacing people in a clip. Pass the source clip in `refs.video` (`@Video1`) and one still per actor in `refs.image` (`@Image1`…), then map each still onto an on-screen person:

```
Replace the on-screen person matching @Image1 with @Image1 as character reference. Replace the on-screen person matching @Image2 with @Image2 as character reference. Replace the on-screen person matching @Image3 with @Image3 as character reference. Keep camera movement, pacing, and framing of @Video1.
```

Notebook wiring: connect the source video plus the identity stills to a Seedance generation cell (model `kie:bytedance/seedance-2-5`, mode `v2v` / Edit video). Use one source video with a known duration of 4–30 seconds; import URL sources into the book first. Edit mode sets `aspect_ratio=adaptive` and `duration=-1` to preserve the source shape and length. Ordinary reference generation remains `r2v` with its chosen output settings. The runner fills `refs.video` from connected video cells and `refs.image` from connected image cells. The result is a normal generated video artifact (`original.mp4` / `proxy.mp4`), not an orientation render.

## Camera Movement Vocabulary

Explicit camera direction is the single highest-leverage prompt component.

- Dolly: "slow dolly-in," "push forward"
- Pan / tilt: "pan right," "tilt upward"
- Zoom: "slow zoom to close-up," "dolly zoom"
- Tracking: "tracking shot," "follow from behind," "close-up surround shots"
- Static: "static wide shot," "camera holds steady"
- Angle: "extreme wide shot," "low angle," "overhead"
- Lens: "anamorphic lens flare," "bokeh background"
- Perspective: "third-person to subjective POV," "first-person handheld"

## Multi-Shot, Scene Cuts, Timestamps

A single generation can contain natural cuts (up to 15s). Use scene-cut and timecode language to control pacing:

- `Cut scene to …`
- `At 5 seconds, …`
- `[00:00-00:04] Shot 1: …`

Shot-script template for multi-shot output:

```
【Style】Denis Villeneuve sci-fi epic
【Duration】10s
[00:00-00:04] Shot 1: Establishing wide (low-angle dolly-in). Description with physical details.
[00:04-00:07] Shot 2: Close-up surround (tracking arc). Description.
[00:07-00:10] Shot 3: POV (handheld). Description.
Consistency: same wardrobe and lighting across all shots.
```

## Variants and Parameters

All variants share these output parameters:

| Parameter | Values |
|---|---|
| `resolution` | `480p`, `720p` (fal.ai also lists `1080p` for r2v) — default `720p` |
| `duration` | `auto`, `4`–`15` seconds (integer) — default `auto` |
| `aspect_ratio` | `auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| `generate_audio` | bool, default `true` — synchronized music/SFX/dialogue |
| `seed` | int, optional |

Variant-specific inputs:

- **t2v** — `prompt` only
- **i2v** — `prompt` + `image_url` (first frame) + optional `end_image_url` (last frame)
- **r2v** — `prompt` + `image_urls[≤9]` + `video_urls[≤3]` + `audio_urls[≤3]`, total ≤12

## Style Anchoring

Generic terms ("cinematic," "epic") underperform specific anchors. Reference an actual director, film, or art movement: "Denis Villeneuve sci-fi epic," "Wong Kar-wai neon street photography," "Studio Ghibli watercolor backgrounds." Anchor early in the prompt.

## Physics and Body Language

Seedance 2.0 simulates fluid dynamics, cloth, and character motion. Prompts that describe physical reactions ("hair lifts in the wind," "fabric ripples as she turns") consistently outperform prompts that describe abstract emotion ("she feels free"). Describe the body, not the feeling.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Vague subject ("a cool car video") | Add specific descriptors and camera direction |
| @-tag references a non-existent file (e.g., `@Image3` with 2 uploaded) | Verify upload order; tags start at 1 |
| @-tag with no role | State what the file is for: "as first frame," "as background" |
| No camera direction | Add explicit movement (dolly, tracking, POV) |
| Generic style ("cinematic") | Anchor to a specific director/film/movement |
| Conflicting text vs. reference | Align prompt with the actual content of @-tagged files |
| >150 words | Trim — long prompts dilute the load-bearing instructions |
| No duration in prompt OR API | Set both — prompt language plus the `duration` parameter |
| Multiple actions, no timecodes | Use `[00:00-00:05]` format to bind events to time |

## Key Takeaways

- Five-part formula: Subject + Action + Camera + Style + Constraints
- Every @-tag needs an explicit role ("as first frame," "as character reference," "Refer to camera movement of")
- Camera direction is mandatory — the model defaults to bland motion without it
- Style anchors should name a director or film, not a genre
- For multi-shot output, use timecodes (`[00:00-00:04]`) and named shots
- Describe physics and body language, not abstract emotion
- Keep prompts under ~150 words
- `generate_audio: true` (default) — say "no audio" in the prompt isn't enough, set the flag
- Match reference files to prompt text; conflicting signals degrade the output
