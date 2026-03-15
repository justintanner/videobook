---
source: "https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1 , https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/video-gen-prompt-guide , https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/best-practice"
type: reference
date_added: 2026-02-15
---

# Veo 3.1 Prompting Guide

Compiled from official Google Cloud documentation covering Veo 3.1 prompting techniques, camera controls, native audio, character consistency, and image-to-video workflows.

## Summary

Veo 3.1 is Google's latest video generation model, building on Veo 3 with stronger prompt adherence and improved audiovisual quality. Key capabilities include high-fidelity video at 720p or 1080p, native audio generation (dialogue, SFX, ambient), native 9:16 portrait support, variable clip lengths (4, 6, or 8 seconds), image-to-video animation, "ingredients to video" for character/style consistency, and "first and last frame" transitions.

## Prompt Structure

The recommended five-part formula:

**[Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]**

- **Cinematography**: Camera work and shot composition (shot type, angle, movement, lens)
- **Subject**: Main character or focal point (person, animal, object)
- **Action**: What the subject is doing (movement, interaction, expression)
- **Context**: Environment, time of day, weather, atmospheric details
- **Style & Ambiance**: Overall aesthetic, mood, lighting, color palette

Example: "Medium shot, a tired corporate worker, rubbing his temples in exhaustion, in front of a bulky 1980s computer in a cluttered office late at night. The scene is lit by the harsh fluorescent overhead lights and the green glow of the monochrome monitor. Retro aesthetic, shot as if on 1980s color film, slightly grainy."

You don't need all elements in every prompt, but understanding each enables more effective results. Use direct language that eliminates ambiguity.

## Camera Angles

- **Eye-Level Shot** — Neutral, common perspective from human height. "eye-level shot of a woman sipping tea"
- **Low-Angle Shot** — Camera below subject looking up; makes subject appear powerful/imposing. "low-angle tracking shot of a superhero landing"
- **High-Angle Shot** — Camera above subject looking down; makes subject seem small/vulnerable. "high-angle shot of a child lost in a crowd"
- **Bird's-Eye View / Top-Down** — Directly from above; map-like perspective. "bird's-eye view of a bustling city intersection"
- **Worm's-Eye View** — Very low from ground level looking up; emphasizes height/grandeur. "worm's-eye view of towering skyscrapers"
- **Dutch Angle / Canted Angle** — Camera tilted to one side; conveys unease/disorientation/dynamism. "dutch angle shot of a character running down a hallway"
- **Close-Up** — Frames subject tightly, typically on face; emphasizes emotions/details. "close-up of a character's determined eyes"
- **Extreme Close-Up** — Isolates very small detail like an eye or water drop. "extreme close-up of a drop of water landing on a leaf"
- **Medium Shot** — Subject from approximately waist up; balances detail with context; common for dialogue. "medium shot of two people conversing"
- **Full Shot / Long Shot** — Entire subject head to toe with surrounding environment visible. "full shot of a dancer performing"
- **Wide Shot / Establishing Shot** — Subject within broad environment; establishes location/context. "wide shot of a lone cabin in a snowy landscape"
- **Over-the-Shoulder Shot** — From behind one person looking at another; common in conversations. "over-the-shoulder shot during a tense negotiation"
- **Point-of-View Shot** — Scene from direct perspective of a character. "POV shot as someone rides a rollercoaster"

Note: Some advanced camera angles are not officially supported. Results and reliability may vary depending on the overall prompt.

## Camera Movements

- **Static Shot / Fixed** — Camera remains completely still. "static shot of a serene landscape"
- **Pan (Left/Right)** — Camera rotates horizontally from fixed position. "slow pan left across a city skyline at dusk"
- **Tilt (Up/Down)** — Camera rotates vertically from fixed position. "tilt down from the character's shocked face to the letter in their hands"
- **Dolly (In/Out)** — Camera physically moves closer or further away. "dolly out from the character to emphasize their isolation"
- **Truck (Left/Right)** — Camera moves horizontally/sideways, parallel to subject. "truck right, following a character as they walk along a busy sidewalk"
- **Pedestal (Up/Down)** — Camera moves vertically while maintaining level perspective. "pedestal up to reveal the full height of an ancient, towering tree"
- **Zoom (In/Out)** — Lens changes focal length (camera doesn't move). "slow zoom in on a mysterious artifact on a table"
- **Crane Shot** — Camera on crane, moves vertically or in sweeping arcs; dramatic reveals. "crane shot revealing a vast medieval battlefield"
- **Aerial Shot / Drone Shot** — From high altitude with smooth flying movements. "sweeping aerial drone shot flying over a tropical island chain"
- **Handheld / Shaky Cam** — Less stable, jerky movements; conveys realism/immediacy/unease. "handheld camera shot during a chaotic marketplace chase"
- **Whip Pan** — Extremely fast pan that blurs image; transition or rapid movement. "whip pan from one arguing character to another"
- **Arc Shot** — Camera moves in circular or semi-circular path around subject. "arc shot around a couple embracing in the rain"

Specify speed ("slow dolly," "rapid pan"), define start/end points, layer movements, and match movement to mood.

## Lens & Optical Effects

- **Wide-Angle Lens** — Broader field of view, exaggerates perspective, grand scale. "wide-angle lens shot of a grand cathedral interior"
- **Telephoto Lens** — Narrows field of view, compresses perspective, isolates subject. "telephoto lens shot capturing a distant eagle in flight"
- **Shallow Depth of Field** — Narrow plane in focus, blurred foreground/background with bokeh. "portrait with shallow depth of field, face sharp against softly blurred park background"
- **Deep Depth of Field** — Most/all of image in sharp focus from foreground to background. "landscape with deep depth of field, sharp detail from wildflowers to distant mountains"
- **Lens Flare** — Streaks/starbursts from bright light; dramatic/cinematic effect. "cinematic lens flare as the sun dips below the horizon"
- **Rack Focus** — Shifts focus from one subject to another within a continuous shot. "rack focus from a character's face in foreground to photograph on wall behind"
- **Fisheye Lens** — Ultra-wide-angle with extreme barrel distortion. "fisheye lens view from inside a car, capturing driver and curved dashboard"
- **Dolly Zoom (Vertigo Effect)** — Dolly toward/away while zooming opposite direction; background perspective shifts dramatically. "vertigo effect on a character standing at cliff edge"

Note: Some advanced lens effects are not officially supported. Results may vary.

## Visual Style & Aesthetics

### Lighting
- **Natural Light**: "soft morning sunlight streaming through a window," "overcast daylight," "moonlight"
- **Artificial Light**: "warm glow of a fireplace," "flickering candlelight," "harsh fluorescent office lighting," "pulsating neon signs"
- **Cinematic Lighting**: "rembrandt lighting on a portrait," "film noir with deep shadows and stark highlights," "high-key lighting for bright cheerful scene," "low-key lighting for dark mysterious mood"
- **Specific Effects**: "volumetric lighting creating visible light rays," "backlighting to create a silhouette," "golden hour glow," "dramatic side lighting"

### Tone & Mood
Happy/Joyful, Sad/Melancholy, Suspenseful/Tense, Peaceful/Serene, Epic/Grandiose, Futuristic/Sci-Fi, Vintage/Retro (e.g., "1950s Americana," "1980s vaporwave"), Romantic, Horror.

### Artistic Style
- **Photorealistic**: "ultra-realistic rendering," "shot on 8K camera"
- **Cinematic**: "cinematic film look," "shot on 35mm film," "anamorphic widescreen"
- **Animation**: "Japanese anime style," "Pixar-like 3D animation," "claymation style," "stop-motion animation," "cel-shaded animation"
- **Art Movements**: "in the style of Van Gogh," "surrealist painting," "Art Deco design"
- **Specific Looks**: "gritty graphic novel illustration," "watercolor painting coming to life," "charcoal sketch animation"

### Color & Atmosphere
- **Color Palettes**: "monochromatic black and white," "vibrant saturated tropical colors," "muted earthy tones," "cool blue and silver futuristic palette," "warm autumnal oranges and browns"
- **Atmospheric Effects**: "thick fog rolling across a moor," "gentle falling snow," "heat haze shimmering above asphalt," "magical glowing particles in air"

## Native Audio

Veo 3.1 generates a complete soundtrack from text instructions. Use separate sentences to describe each audio element.

### Dialogue
Use a colon after the speaker — do NOT use quotation marks (they cause the model to render text visually in the video):
- **Correct**: A woman says: My name is Clara.
- **Incorrect**: A woman says: "My name is Clara."

Include tone descriptors: "in a weary voice," "with a crisp, analytical tone," "nervously," "whispering."

### Sound Effects (SFX)
Describe individual, distinct sounds: "the sound of a phone ringing," "thunder cracks in the distance," "the creak of a closet door."

### Ambient Noise
Define the background soundscape: "sounds of city traffic and distant sirens," "waves crashing on shore," "the quiet hum of a starship bridge."

## Character Consistency

To maintain consistent characters across multiple scenes:

1. **Detailed character foundation**: Create exhaustive descriptions including physical build, age, hair characteristics, facial structure, eye specifications, clothing, voice style, and defining marks.
2. **Consistent application**: Copy the entire unchanged character description into every scene prompt. Modify only the action/setting components.
3. **Seed parameter**: Apply identical seed parameters across scenes for consistent visual, stylistic, and vocal output.

Example — same character across scenes: repeat the full description ("Clara, a historian in her early 30s, with observant, dark brown eyes that hold a quiet intensity. She has chin-length, black hair styled in a classic bob. She is dressed in a sophisticated, dark navy-blue wool coat...") in every prompt, changing only the scene and action.

## Aspect Ratios

- **16:9 (Landscape/Widescreen)** — Default. Standard for TVs, monitors, YouTube, presentations. Excellent for expansive backgrounds and scenic landscapes.
- **9:16 (Portrait/Vertical)** — Essential for mobile-first platforms: TikTok, Instagram Reels, YouTube Shorts. Ideal for portraits and tall subjects (buildings, trees, waterfalls).

## Image-to-Video

**Source image quality matters**: A sharp, clear, well-composed photograph yields a more coherent, higher-quality video. Think of your source image as the first frame of your film.

**Prompt for motion only**: The source image already provides subject, scene, and style. Do NOT re-describe characters, backgrounds, or lighting depicted in the image — redundant descriptions confuse the model and degrade results.

**Character references**: In motion prompts, use general terms: "the subject," "the woman," "he," "she," or "they."

**Three movement types** (can be combined):
- **Camera Motion**: Camera moves while scene is static. "Slow dolly in on the subject."
- **Subject Animation**: Main character/object moves. "The character's hair and clothes flutter gently in the wind."
- **Environmental Animation**: Background/atmosphere comes alive. "Fog rolls in slowly across the landscape."

## Negative Prompts

Describe unwanted elements as a noun list — do NOT use instructive language like "no" or "don't":
- **Correct**: "wall, frame, urban background, man-made structures"
- **Incorrect**: "no walls" or "don't show walls"

## Common Mistakes

1. **Quotation marks in dialogue** — Causes the model to render text visually in the video. Use colons instead.
2. **Chaining multiple scenes in one prompt** — For short videos, dedicate each prompt to one focused moment. Multi-event prompts produce muddled or incomplete results.
3. **Vague prompts** — "a scene where the main focus is kinda sad" vs. "Low-angle close-up shot of a man with a somber expression, dimly lit, conveying a melancholic mood."
4. **Re-describing source image in image-to-video** — The image already provides visual context. Only prompt for desired motion.
5. **Conflicting camera/style cues** — Avoid contradictory instructions (e.g., "static shot with dramatic crane movement").

## Key Takeaways

- Structure prompts: Cinematography + Subject + Action + Context + Style & Ambiance
- Use specific cinematic terminology for camera angles, movements, and lens effects
- Avoid quotation marks in dialogue — use colons after the speaker
- Focus each prompt on a single scene or moment
- For image-to-video, prompt only for motion — don't re-describe the source image
- Maintain character consistency by repeating full descriptions and using the same seed
- Negative prompts should be noun lists, not instructions
- Use separate sentences for dialogue, SFX, and ambient audio
- Choose 16:9 for landscape or 9:16 for mobile-first vertical content
