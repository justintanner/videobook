---
source: "docs.x.ai/docs/guides/image-generation, docs.x.ai/docs/guides/video-generation, grokimagineai.net/prompt-guide, genaintel.com/guides/how-to-prompt-grok-imagine"
type: reference
date_added: 2026-02-14
---

# Grok Imagine Prompting Guide

## Summary

Grok Imagine is xAI's multimodal generation system built on the Aurora model, an autoregressive mixture-of-experts network trained on interleaved text and image data. It supports text-to-image, image editing, text-to-video, image-to-video, and video editing. Aurora excels at photorealistic rendering and precise instruction following. Grok Imagine responds best to natural language scene descriptions rather than keyword lists — write prompts like scene direction, not tag stacking.

## Key Takeaways

- Prompts should read as natural scene descriptions, not keyword lists — the model interprets context intelligently
- **Text-to-video formula:** Subject + Movement + Scene + Shot, Style
- **Image-to-video formula:** Subject + Motion, Background + Motion, Camera + Motion
- **Five-part structure for images:** Scene (what's happening) + Style (aesthetic) + Mood (emotional direction) + Lighting (time/quality) + Camera (shot type/lens/focus)
- Place the main subject and action first — the model weights the opening of the prompt most heavily
- Image-to-video prompts should reduce static element descriptions since the model expands from the input image
- Negative prompts are ignored by the model — use explicit positive descriptions instead
- Camera movement commands understood: zoom, pan, tilt, surround, aerial, follow, handheld, lens switching
- Use "Shot Switch" to separate distinct camera angles in multi-shot sequences
- Select "unfixed lens" when including camera movement in video generation
- Intensity modifiers (quickly, violently, with large amplitude, powerfully, wildly) specify motion the model cannot infer from static images
- Iterative refinement works best when adjusting one variable per iteration (lighting OR camera OR mood)
- Batch generation supports up to 10 images per request for same-prompt variations

## Style Keywords

- **Realism:** photoreal detail, natural lighting, documentary feel
- **Anime:** vibrant cel-shading, expressive linework
- **Painterly:** oil-painting texture, impressionist glow
- **Cinematic:** volumetric lighting, film grain, dynamic shadows
- **Surreal:** dreamlike distortion, ethereal glow
- **Graphic Novel:** inked outlines, bold contrasts, neon lines
- Also supports: pencil sketch, pop art, watercolor, impressionism

## Composition Control

- Wide establishing shots for scale and context
- Low-angle shots for heroic or imposing framing
- Close-ups for emotion and texture
- Over-the-shoulder for conversation and tension
- Shallow depth of field for subject isolation

## Emotion-Driven Language

The model responds strongly to atmospheric vocabulary: nostalgic, melancholic, electric, tense, dreamlike. Emotional tone shapes the entire output more than technical descriptors alone.

## Technical Parameters

### Image Generation
- **Aspect ratios:** 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, auto
- **Resolution:** 1K or 2K
- **Batch size:** up to 10 images per request
- **Pricing:** flat per-image (not token-based)

### Video Generation
- **Duration:** 1–15 seconds (generation), up to 8.7 seconds (editing)
- **Resolution:** 480p or 720p
- **Aspect ratios:** 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3
- **Lens type:** fixed or unfixed (unfixed required for camera movement)

## Common Mistakes

- Tag stacking instead of natural language (produces generic results)
- Weak verbs — use "surges," "unfurls," "erupts" instead of "standing," "sitting"
- Missing time-of-day or weather cues
- Vague aesthetic directions without specific style anchors
- Conflicting adjective overload
- Contradicting the input image in image-to-video prompts
