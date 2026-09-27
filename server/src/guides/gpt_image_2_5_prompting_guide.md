---
source: "https://developers.openai.com/api/docs/guides/image-generation"
models: "GPT Image 2.5 Sunburst and Flare"
---

# GPT Image 2.5 Prompting Guide

Sunburst is the default for precise image editing. Flare is available for fast everyday generation. Both support text prompts and reference images.

Describe the subject, composition, setting, lighting, style, and intended use in clear language. Put essential constraints first. Quote any exact text that must appear and describe its placement and typography.

For edits, state what must change and what must remain: identity, pose, framing, colors, layout, or background. Refer to multiple inputs by their order, such as image 1 and image 2, and describe the role of each. Preserve the user's reference order and requested visual details.

Videobook uses Kie's GPT Image 2.5 endpoints. Supported controls come from Apicity:

- Up to 16 optional reference images; no references selects text-to-image.
- Aspect ratio: auto, 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 21:9, 27:16, 16:27, 9:8, or 8:9.
- Resolution: 1K, 2K, or 4K. Ratios 27:16, 16:27, 9:8, and 8:9 require 1K.
- Background: transparent, opaque, or auto.

Use only controls exposed by the selected provider. Keep aspect ratio, resolution, and background in their structured fields instead of adding API parameter names to the visual prompt. Do not add quality or NSFW-checker parameters to these Kie requests.
