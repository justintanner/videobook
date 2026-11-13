---
source: "@apicity/fal 0.27.3 and @apicity/kie 0.28.0 request schemas for GPT Image 2.6; edit advice from the GPT Image 2.5 guide (https://developers.openai.com/api/docs/guides/image-generation)"
models: "GPT Image 2.6 Sunburst and Flare on Kie and fal"
---

# GPT Image 2.6 Prompting Guide

Sunburst is the default for precise image editing. Flare is faster for everyday generation. Each has a text-to-image endpoint and an edit endpoint.

Describe the subject, composition, setting, lighting and intended use in clear language. Put essential constraints first. Quote any exact text that must appear and describe its placement and typography.

For edits, state what must change and what must remain: identity, pose, framing, colors, layout or background. Refer to inputs by their order, such as image 1 and image 2, and describe the role of each. Preserve the reference order and the requested visual details.

Videobook serves GPT Image 2.6 through Kie and fal. Supported controls come from Apicity:

- Size: Kie takes aspect_ratio (auto, or 3:1 to 1:3) and resolution (1K, 2K or 4K); fal takes image_size, a preset, auto or a width and height in multiples of 16. fal edits default to auto, which follows the input images.
- quality: auto, low, medium, high, xhigh or max; high by default.
- Kie complexity and fal reasoning_effort: low, medium or high; high by default. More effort helps dense text and complex layouts.
- Up to 16 reference images for an edit.
- A mask, where white marks what to edit, or a markup image of annotations that guide the edit of the first image, but not both.
- Output as JPEG, PNG or WebP.

Keep these controls in their structured fields instead of writing parameter names into the prompt.
