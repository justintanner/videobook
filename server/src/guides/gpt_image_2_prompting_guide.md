---
source: "platform.openai.com/docs/guides/image-generation, platform.openai.com/docs/models/gpt-image-1.5, learnprompting.org, evolink.ai, digitalapplied.com, img.ly"
type: reference
date_added: 2026-02-15
---

# GPT Image 1.5 Prompting Guide

## Summary

GPT Image 1.5 is OpenAI's second-generation image generation model (API model ID: `gpt-image-1.5`), launched December 16, 2025. It powers the ChatGPT Images feature and is built on GPT-4o's multimodal architecture. Key advances over GPT Image 1 include 4x faster generation (8-12 seconds vs 35-45 seconds), 20% lower cost, improved instruction following, region-aware precision editing, and better dense text rendering. It ranks #1 on LMArena, Design Arena, and AA Arena benchmarks. The model produces a "commercial photography" aesthetic — professionally lit and polished.

## Key Takeaways

- Prompts should follow: Subject + Action + Setting + Style + Technical Specs + Composition
- The model excels at instruction following — it reliably adheres to layout specs, color palettes, compositional rules, and text placement
- Text rendering handles 1-5 word headlines reliably; body text beyond 20-30 words degrades
- Region-aware editing preserves unrelated elements (face, lighting, logos) during modifications
- Supports up to 6-8 edit iterations before quality compounds errors
- Negative prompts are not supported — use explicit positive descriptions
- Concise, constraint-based prompts outperform verbose descriptions (28 tokens beats 87 tokens)
- Multi-turn conversation refinement is a core workflow — iterate by requesting specific adjustments
- Up to 16 reference images supported for image-to-image mode
- Outputs have a distinctly "commercial photography" look — not ideal for candid or documentary aesthetics

## Prompt Structure

**Recommended formula:**

`[SUBJECT] + [ACTION] + [SETTING] + [STYLE] + [TECHNICAL SPECS] + [COMPOSITION]`

**Template variants by use case:**

- **Text/Infographics:** "Create a [content_type] explaining [subject] in [detail_level]. The background should be [background_style], and include [text_elements] with [annotation_style]."
- **Creative Illustrations:** "Generate a [style] image of [subject] positioned on [background/setting]. Include the text: [text content] with [typography style] typesetting."
- **Marketing Materials:** "Design a [document type] for a [business type] named [name] in [location/style]. The style should be [descriptor 1] yet [descriptor 2]."
- **Photorealistic Scenes:** "Generate a photorealistic image of [scene/location] during [time/condition] with [elements], without [excluded elements], emphasizing [mood]."
- **UI/UX Prototypes:** "Create a [platform] interface for a [genre] [application type]. The design should include [UI elements] at [positions], rendered in [style]."

## Prompting Best Practices

### Be Specific and Concise
Define background color, text styling, layout preferences, and artistic influences. But remove unnecessary adjectives — clarity and constraint beat verbosity. Think product spec, not poetry.

**Instead of:** "A beautiful, stunning, incredibly detailed photograph of a sleek modern smartphone sitting elegantly on a pristine white surface with gorgeous soft lighting cascading gently from above"

**Write:** "Professional product photo: smartphone on white background, soft studio lighting from above"

### Provide Context
Explain the image's purpose — educational, branding, or creative storytelling. Context helps the model tailor outputs.

### Use Artistic Language
Reference specific mediums or styles: watercolor, oil painting, 80s anime aesthetic, studio photography, Kodak Portra 400. These anchors lock onto particular visual identities.

### Specify Text Explicitly
- Position text: "Headline centered at top"
- Request high contrast for readability
- Keep to 1-5 word headlines for reliability
- Avoid requesting font sizes smaller than 18pt equivalent
- Readable product labels work well at 2-3 lines

### Step-by-Step for Complex Images
Decompose tasks: generate the background first, then add text elements, finally incorporate additional objects or effects.

## Text Rendering

### What Works Well
- 1-5 word headlines in bold fonts
- Product labels (2-3 lines)
- Magazine-style layouts with visible headlines
- Dense text, markdown tables, and small typography (improved in 1.5)

### What Breaks
- Body text exceeding 20-30 words (spelling errors appear)
- Non-Latin scripts (inconsistent results)
- Text on curved surfaces (frequent distortion)
- Handwriting and decorative fonts (unreliable)

**Hybrid workflow tip:** Generate the base image with GPT Image, add complex typography in Figma/Photoshop.

## Image Editing

- Accepts up to 16 reference images simultaneously
- Region-aware editing automatically identifies which pixels to preserve
- No manual masking required — semantic segmentation is automatic
- Describe the entire resulting image in edit prompts, not just the masked region
- Maintains facial identity, lighting, background, color grading, and logos across edits
- Quality degrades after 5-6 consecutive edits due to error compounding

## Technical Parameters

| Parameter | Options |
|-----------|---------|
| **Model** | `gpt-image-1.5` |
| **Quality** | `low`, `medium`, `high`, `auto` (default) |
| **Size** | `1024x1024` (square), `1024x1536` (portrait), `1536x1024` (landscape), `auto` |
| **Format** | JPEG, PNG, WEBP |
| **Compression** | 0-100% adjustable |
| **Background** | Transparent (PNG/WEBP only) or solid |
| **Max prompt** | 2000 tokens |
| **Images per request** | 1 |
| **Reference images** | Up to 16 (max 50MB total) |

## Pricing (1024x1024)

| Quality | Cost per Image |
|---------|---------------|
| Low | $0.009 |
| Medium | $0.034 |
| High | $0.133 |

**Recommended allocation:** 80% Low (iteration), 15% Medium (digital assets), 5% High (final production).

## Advanced Techniques

- **Style Transfer:** Preserve narrative elements while adapting visual aesthetics across artistic traditions
- **Branded Consistency:** Use identical style terms, color palettes, and layout descriptions across prompts (no persistent memory between requests)
- **Grid Generations:** 2x2 and 4x4 grids work well because autoregressive generation understands previously-rendered sections
- **Era/Aesthetic Anchoring:** Film stocks ("Kodak Portra 400") and time periods trigger consistent visual language
- **Conceptual Marketing:** Combine artistic movements with brand messaging (e.g., solarpunk for environmental brands)

## Strengths vs Competitors

| Strength | GPT Image 1.5 |
|----------|---------------|
| Instruction following | Best in class |
| Text rendering | Strong (short text) |
| Speed | 8-12 seconds |
| Precision editing | Region-aware, no masking needed |
| Commercial aesthetic | Polished, professional |

| When to Use Alternatives | |
|--------------------------|---|
| Superior photorealism | Nano Banana Pro |
| Artistic interpretation | Midjourney |
| Full model customization | Stable Diffusion |
| Candid/documentary look | Nano Banana Pro |

## Common Mistakes

- Verbose, overloaded prompts — keep concise and constraint-based
- Requesting long text passages — stick to headlines and short labels
- Expecting persistent memory between requests — repeat style specs every time
- Over-editing — quality degrades after 5-6 iterations
- Using high quality for iteration — use low for drafts, high for finals only
- Complex scenes with 10+ distinct objects — spatial inconsistencies appear
- Transparent materials (glass, water) — produces artifacts
