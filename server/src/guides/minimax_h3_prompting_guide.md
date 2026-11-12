---
source: "https://fal.ai/models/minimax/h3-max/reference-to-video/api and https://fal.ai/models/minimax/h3-max/extend-video/api"
models: "MiniMax H3 Max reference-to-video and Extend on fal"
note: "fal publishes no prompting guide for H3 Max. This guide is written from the parameter descriptions on those pages (read 2026-11-12), which match the apicity request schema descriptions."
---

# MiniMax H3 Max Prompting Guide

Write one beat per clip: one continuous action in present tense and plain words. Say who moves, what they do and where they end up. Leave out lists of adjectives and style words.

Say what the camera does, and keep to one camera behaviour per beat: a phone held at chest height, a slow walk behind the subject, or a camera that stays still.

Say what is heard, such as footsteps, rain on a roof or a passing bus. H3 always makes its own soundtrack, so name the sounds you want and say what stays quiet.

Name reference images by their order in the reference list: Image 1, Image 2. Say what each one is, for example "Image 1 is the man in the green shirt", so the same person keeps the same face and clothes.

A first frame fixes the opening picture: the clip opens exactly on that image and takes its shape. Describe what happens from there, not the picture itself.

A continuation (Extend) describes only what happens next. Do not retell the source clip; carry on from its last moment in the same place and light.

End every beat with the subject still in frame, so the next beat can continue the same shot.

With prompt expansion disabled the model follows the prompt as written, so include every detail that matters. Keep duration, resolution and aspect ratio in their fields, not in the prompt.
