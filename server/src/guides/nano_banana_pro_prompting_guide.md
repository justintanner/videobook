---
source: "blog.google/products/gemini/prompting-tips-nano-banana-pro/, wavespeed.ai, minimaxir.com, imagine.art, github.com/ZeroLu/awesome-nanobanana-pro"
type: reference
date_added: 2026-02-13
---

# Nano Banana Pro Prompting Guide

## Summary

Nano Banana Pro is Google DeepMind's image generation model built on Gemini 3 Pro, launched November 2025. It introduces thinking mode (the model reasons through prompts before generating), search grounding (real-time Google Search integration for factual accuracy), text rendering (legible multi-language text directly in images), multi-image input (up to 14 reference images), and high-resolution output (up to 4K).

## Key Takeaways

- Prompts should follow the structure: Subject/Action + Style/Medium + Setting/Atmosphere + Technical Specs + Mood/Emotion
- Six essential prompt components: subject, composition, action, setting/location, style, and editing instructions
- Text rendering excels with specific placement, font, and size instructions — keep to 1-3 text elements per image
- Thinking mode reasons through the prompt and generates interim "thought images" before the final output
- Search grounding connects to Google Search for real-time data — trigger with keywords like "search for," "latest," "today," "current"
- Up to 14 reference images can be provided for character/brand consistency, style direction, and composition guidance
- Supports 1K, 2K, and 4K resolution output
- The model pushes toward realism due to RLHF training — surreal or absurd prompts get normalized
- Explicit negations work reliably: "NEVER include any text, watermarks, or line overlays"
- Photographic specifications (camera model, lens, lighting) significantly improve professional output quality
- JSON-structured prompts can help organize complex multi-element compositions
- Era/aesthetic anchoring through film stocks ("Kodak Portra 400") and time periods triggers consistent visual language
- Grid generations (2x2, 4x4) work well because autoregressive generation understands previously-rendered sections
- Cost: base ~$0.039/image, Pro 2K ~$0.134/image; generation time 20s to 1min+
