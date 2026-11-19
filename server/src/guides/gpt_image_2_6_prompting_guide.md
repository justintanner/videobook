---
source: "@apicity/fal 0.27.3, @apicity/kie 0.28.0, @apicity/wavespeed 0.28.1 and @apicity/machgen 0.28.1 request schemas for GPT Image 2.6; edit advice from the GPT Image 2.5 guide (https://developers.openai.com/api/docs/guides/image-generation)"
models: "GPT Image 2.6 Sunburst and Flare on Kie, fal, WaveSpeed and MachGen"
---

# GPT Image 2.6 Prompting Guide

Sunburst is the default for precise image editing. Flare is faster for everyday generation. Each has a text-to-image endpoint and an edit endpoint.

Describe the subject, composition, setting, lighting and intended use in clear language. Put essential constraints first. Quote any exact text that must appear and describe its placement and typography.

For edits, state what must change and what must remain: identity, pose, framing, colors, layout or background. Refer to inputs by their order, such as image 1 and image 2, and describe the role of each. Preserve the reference order and the requested visual details.

Videobook serves GPT Image 2.6 through Kie, fal, WaveSpeed and MachGen. Controls come from Apicity:

- Size: Kie, WaveSpeed and MachGen take aspect_ratio (3:1 to 1:3) and resolution; fal takes image_size, a preset, auto or a width and height in multiples of 16. fal edits default to auto, which follows the input images.
- quality: low, medium, high, xhigh or max; high by default.
- Kie and WaveSpeed complexity, fal reasoning_effort: low, medium or high; high by default. More effort helps dense text and complex layouts.
- Up to 16 reference images for an edit.
- A mask, where white marks what to edit, or a markup image of annotations that guide the edit of the first image, but not both. MachGen takes neither.
- Output as JPEG, PNG or WebP.

Keep these controls in their structured fields instead of writing parameter names into the prompt.
