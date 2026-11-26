# Changelog

All notable changes to the `videobook` npm package are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Dub a notebook video into up to five languages from its cell. Choose Speed or
  Precision, set lip sync and speaker count, and review the estimated total.
- Seedance 2.5 Flash on fal, WaveSpeed and MachGen, WaveSpeed MAI Image 2.7
  generation and edits, MAI Image 2.7 Flash edits, and SkyReels V4 reference
  video. The pickers use the November 25 frontier boards, including Hyperflow
  H3 at rank 4 for reference-to-video.
- With `@apicity/*@0.31.1`, fal FLUX 3 Max offers 2K and 4K at the promotional
  rates through December 7. MachGen Seedance 2.5 offers 2160p and prices
  reference video at its input-video rate. All three fal HeyGen Video modes
  support 30 seconds, and fal Wan 3.0 and Prime accept 20,000-character prompts.

- Adopted `@apicity/*@0.30.0`, adding three new direct media providers and new
  endpoints across existing providers:
  - **OpenAI** (`OPENAI_API_KEY`): GPT Image 2.6 Sunburst and Flare, GPT Image
    2.5 Sunburst and Flare, and GPT Image 2 for synchronous text-to-image and
    multipart edits of up to 16 book images plus Mask and Markup slots.
  - **Google Vertex** (`GOOGLE_API_KEY` for Nano Banana 2.1;
    `GOOGLE_SERVICE_ACCOUNT_JSON` with `GOOGLE_CLOUD_PROJECT` or service-account
    `project_id` for Gemini Omni): Nano Banana 2.1 images plus Gemini Omni 1.2
    Flash and 1.1 Flash Preview videos with inline book media.
  - **Google Flow** (`GOOGLE_FLOW_API_KEY`): Nano Banana 2.1 images plus async
    Gemini Omni 1.2 Flash and 1.1 Flash videos with asset upload and job polling.
  - **Alibaba** (`DASHSCOPE_API_KEY`): Wan 3.0, Wan 3.0 Prime, and HappyHorse
    1.0 Video Edit via DashScope International async video synthesis.
  - **fal & WaveSpeed**: Kling 4.0 Image text-to-image and edits on both fal
    and WaveSpeed, fal Seedream 5.5 Edit, and WaveSpeed GPT Image 2.5 Sunburst
    and Flare edits.
  - **KIE**: Kling 4.0 reference-to-video and keyframe-to-video now expose `4k`,
    `dynamic_range` (`sdr`/`hdr`), and `4:3`/`3:4` aspect ratios while keeping
    the default resolution pinned to `1080p`.
  - **Fullscreen image editor**: Added OpenAI GPT Image 2.6/2.5/2, WaveSpeed GPT
    Image 2.5 Sunburst and Flare, Google Nano Banana 2.1, and Google Flow Nano
    Banana 2.1 edit providers.
- Subject analysis now finds exact edit masks for uploaded photos and images
  from any model. Select a matched subject to edit it using its mask.
  Analyzing again refreshes a previously cached subject map.
- `/auto-edit @a1`, also **Auto-edit** in a video cell's menu and "auto edit
  @a1" in chat or voice, turns one clip into a short built around its best
  moment: a cold open, then the clip, with the moment replayed wide, punched
  in, pushed in and once more at half speed under a colour-cycling crash look
  with the sound pitched down. The sheet plays the planned edit on the source
  before anything is rendered, beside a timeline that draws each segment of
  the edit above the part of the clip it comes from. Select a clip to trim it on the source
  filmstrip. Drag either handle, enter a Start or End time, or set either edge
  at the playhead. Shared edges list the other clips they affect. **All timing
  markers** opens the body, hook and moment controls. Click the paused picture
  to say where the subject is, or press **Find the moment**, the one paid step, which asks the
  OpenAI model after showing its estimate. Stretches the analysis cuts stay
  inside one Body block, each listed so it can be put back. Cold open,
  Replays, Push-in, Crash and Sounds each switch off, and each says how much
  it adds. **Render** makes
  the edit locally with one FFmpeg encode into a new cell under the source,
  and rendering the same video again adds a version to that cell. Over MCP
  this is the `auto_edit` tool (`get`, `analyze`, `render`), which also
  renders an explicit segment plan.
- **Translated lines** in the subtitle editor (`/subs @a1`) put one or two
  translations under each phrase, such as Thai karaoke with English below.
  The lines carry no highlighting or word motion; each has its own language,
  color and size, appears and disappears with its phrase, and moves with it
  when the subtitles are dragged or step around a face. **Translate** sends
  every phrase to OpenAI in one request, so each line is translated with the
  whole video as context. Lines are kept by the phrase's text, so correcting
  a word, splitting or joining phrases only translates the lines that changed.
  A line can be written by hand in the transcript, and ↺ goes back to the
  machine translation. Render translates missing lines first, and SRT and VTT
  downloads carry every language of a cue. Over MCP, `caption_video` takes
  the `set_translations` and `set_phrase_translation` edits, `prepare`
  translates the lines (`force: ["lines"]` translates them all again), `get`
  reports each language's missing lines, and `render` refuses while any are
  missing.
- Two built-in sounds for `/sfx`, `apply_builtin_sfx`, `/zoom` and auto-edit:
  `shutdown`, the Windows shutdown chime, which ships as a recording
  rather than being synthesized like the others and plays under the
  auto-edit crash, and `error`, two short low tones.

- The **Made with** card of a generated image or video lists the inputs its
  run sent under **Inputs**: each slot, such as `@firstframe` or `@image1`,
  with a thumbnail and the cell it came from, as in `@image1 from @c1`.
  Clicking one selects that cell. The list comes from the recorded request,
  so it stays right after the generator's inputs are rewired, and an input
  whose cell is gone reads "not on the grid". Over MCP,
  `list_cell_generations` attempts carry `inputs` (`slot`, `kind`,
  `artifactId`, `sourceCellId`, `thumbnailUrl`).
- **Extend video** on a KIE Gemini Omni 1.2 Flash cell, or on an extend of
  one, adds a Gemini Omni 1.2 Flash Extend cell with the source's KIE task id
  already filled in, priced at the source's resolution. An Omni cell with no
  KIE task is extended by a model that takes its video instead. KIE extends
  only 360p or 720p videos of at most 15 s, so a 1080p, 4k or longer source,
  or one still generating, is refused in the preview, the estimate and the
  run before anything is sent to KIE.
- In the fullscreen video viewer, press **C** or choose **Crop** to frame a
  16:9, 9:16 or square crop on the paused picture. Drag the box or a corner,
  or use the arrow keys and `+`/`-`. Enter saves a new version of the video
  in the same cell and opens it in the viewer. Escape cancels.
- The fullscreen image editor adds WaveSpeed, MachGen and Nunchux for Nano
  Banana 2.1 and GPT Image 2.6 Sunburst and Flare. MachGen also edits with
  Nano Banana 2, GPT Image 2 and GPT Image 2.5 Sunburst and Flare. Pass the
  provider-prefixed model id to `edit_image_subjects` for these edits.
- In the graphics editor, choose a book image as the default logo and set its
  corner, size and opacity (`video_graphics set_logo`, stored in
  `graphics.logo.v1`). Videos without saved graphics start with that logo.
  Applying a template keeps the video's logo, and saving a template leaves
  the logo out so it can be reused on another video.
- Add a **Box** layer to cover burned-in text anywhere in the picture. Drag
  its edges or corners to fit, then set its colour, opacity and corner
  rounding. Over MCP, `video_graphics` accepts a `box` layer and the
  `set_box` edit.
- An explicit `auto_edit` plan can set frame ranges, speed and audio for
  each segment, zoom between two points and apply `crash`, `invert` or
  `rgb_split`. Retrying the same render with its `request_id` reuses its
  output. Analysis reuses the result for the same video and transcript
  unless `force: true` is passed.

### Changed

- A generated image or video tile names the provider and model that made it
  in a chip on its preview, such as `Kie bytedance/seedance-2-5`, instead of
  in its footer, where the model was usually cut off. While it generates or
  after it fails, the line under its status names them the same way. The
  model no longer repeats the provider, as in `kie · kie:minimax-h3/refer…`.
- The notebook now puts that provider and compact model id on the take's top
  edge beside its generator's address, replacing the chip on the picture and
  the provider line under the clock. An extracted frame shows the time it
  came from. Hover over a shortened model id for the full name. Generator
  headers show the mode, such as **GEN VIDEO · I2V**. Progress, failures
  and the running take count sit below the prompt.
- The footer address replaces the drag grip. Hover over an address such as
  `@b2` for the drag hint, then drop it into an input or a post's empty clip
  slot. A closed hand lifts the address and a dashed line leads back to
  the source. Drag the tile itself to move it.
- Notebook tiles share a footer for the address, facts, status and menu.
  Media versions are counted there, and a ready tile has no check mark.
  Working tiles glow green (cyan for images), missing prompts are marked
  in amber, and Analyze keeps its prompt visible above progress or errors.
  Posts show the clip beside the caption, upload progress and the platform's
  error if posting fails. Portrait previews fill their side bars with a
  blurred copy of the picture.
- **Clean** (`relayout_notebook`) replaces the media-type lanes with rounds.
  Each generator has its inputs on the left and a column of takes for each
  prompt, in run order. The generator heads its current column. Earlier
  columns show what changed in the prompt, and takes carry their prompt
  version. New cells follow the same layout, with renders and posts to the
  right of their take. Unlinked cells follow the rounds, then Timeline rows.
  Goal notebooks keep their goal layout.
- Choose Wan 3.0 Prime, H3 Max Turbo, LTX 2.5 Fast or Pro, FLUX 3 Draft
  and MiniMax H3 LoRA under **Model**. **Provider** lists each provider
  once per variant, such as fal's US endpoint. In the cell editor and chat
  generation review, **Type** lists that provider's compatible operations,
  including ones served by a different endpoint.
- When a video request omits the resolution, Videobook uses the highest the
  model offers. The default rises from 1080p to 4K for fal FLUX 3 Max
  text-to-video, image-to-video and keyframes-to-video, and from 1080p to
  2160p for MachGen Seedance 2.5. An explicit resolution still takes
  precedence. Choose 1080p to keep the earlier price.
- Opening the graphics editor hides the chat log and gives the editor the
  full width of the dock, with the preview beside the controls and the
  layer timeline below. Templates show thumbnails. Use the text controls
  to add a headline, second line or credit to a template that lacks one.
- A text layer's **Text** and **Block** tabs both show its background colour
  and opacity. Set opacity to 0% to clear the background or 100% to cover
  text behind it. Picking a colour while the background is off turns it on
  at 100%.
- In narrow or short windows, composer **Actions** rows keep the selected
  command in view. A short description sits below the command in a narrow
  window and beside it in a short, wide one. Search matches the full text.

### Removed

- Removed `machgen:MiniMax-H3-Omni`, retired upstream in `@apicity/machgen@0.30.0`.
- Generation **Provider** menus no longer show prices beside provider names.
- The pre-release built-in sound id `power_down` was renamed to `shutdown`.

### Fixed

- A cold open whose highlight comes late in a clip no longer keeps the clip
  in memory up to that point while it renders. On a 30 s 1080x1920 clip with
  the highlight at 20 s, peak memory went from about 1.7 GB to 860 MB.
- When auto-edit analysis picks a cold open, the body now starts again at
  the beginning of the clip. Drag **Body start** to choose a different cut.
- A successful download retry, or choosing a file to recover a failed
  download, clears the error on the asset and its notebook tile.
- Selecting a tile keeps it centred above the preview when the dock changes
  size during the scroll.
- The model and provider menus in the fullscreen image editor fit inside the
  controls even in a narrow window.
- Tile font weights now apply only inside notebook tiles, preserving the
  lettering in action sheets, settings and sequence-preview captions.

## [0.8.3] - 2026-11-20

### Added

- KIE models: Kling 4.0 Image for text-to-image and edits of up to 10 images,
  GPT Image 2.6 Economy for text-to-image and edits at a flat price, Grok
  Imagine Image 2.0 Edit for edits of 1-5 images, Seedance 2.5 Flash at 480p
  or 720p for text, frames and references, LTX 2.5 Fast and Pro for text and
  image to video, LTX 2.5 Fast audio-to-video that follows a connected audio
  clip, and Gemini Omni 1.2 Flash Extend, which adds 3-10 s to a 360p or 720p
  Gemini Omni 1.2 Flash video KIE made in this book (pass its task id) and is
  priced at that video's resolution.
- fal MAI Image 2.7 for text-to-image, and MAI Image 2.7 and MAI Image 2.7
  Flash edits of up to 5 images. fal bills them by tokens, so their cost is
  known once they run.
- MachGen Gemini Omni 1.2 Flash for text, first and last frames and
  references of up to 6 images and 3 videos, which it can edit or extend;
  Seedream 5.5 for text-to-image and edits of up to 10 images; and Hyperflow
  H3 and Pika H3 Flex, which run through MiniMax H3 Turbo.
- WaveSpeed SkyReels V4 image-to-video with a first frame, an optional last
  frame and up to six keyframes between them.
- Nunchux GPT Image 2.6 Sunburst and Flare for text-to-image and edits of up
  to 16 images plus a Mask or Markup image. Book images are sent inline, and
  each run is priced from the tokens Nunchux reports.
- Each book remembers the provider you choose for a model. When you pick that
  model again in the cell editor, the chat generation review, the Actions
  sheet or the fullscreen image editor, that provider is selected while it is
  configured and can take the inputs; changing only the model saves nothing.
  The choices are kept in the book setting `generation-provider-memory`,
  notebook payloads carry them as `generation_provider_memory`, and the new
  `remember_generation_provider` (`family_id`, `provider`) saves one.
- The fullscreen image editor adds GPT Image 2.6 Sunburst and Flare edits on
  KIE and fal, and a second provider for Nano Banana 2.1 and GPT Image 2 (fal)
  and Nano Banana Pro (KIE). `edit_image_subjects` accepts their model ids;
  the existing ids, the default model and saved edit cells are unchanged.
- A generated image or video's inspector replaces the "From @b4" link with a
  **Made with** card that still links to the generator. It shows the
  provider, model and date of the run that made the output on screen, its
  prompt as written, with chips for inputs such as `@image1`, and as sent,
  how long it took and what it cost. With no recorded run, or when the runs
  cannot be read, it says so and shows the generator's current settings. The
  prompt there and in a running generation's details has a copy button.
- Under that card, **Takes from @b4** lists every run of the generator,
  newest first, with its output's address and thumbnail, model, status and
  cost (billed, or the quote while it runs), and the generator's total billed
  and pending. The take on screen is marked and clicking another selects its
  output; a take whose output cell was deleted stays listed. Over MCP,
  `list_cell_generations` attempts carry `outputCellId`, and `get_book_usage`
  with `scope.cell_id` adds the cell's totals per run in `runs`.

### Changed

- Every `@apicity` package moves to 0.29.0. Model ranks follow the 2026-11-19
  leaderboards.
- KIE Seedance 2.5 offers a 4k tier and keeps 1080p as its default. KIE Grok
  Imagine image-to-image takes up to 5 images, and KIE GPT Image 2 edits,
  Seedream 5 Lite and Grok Upscale gain the background, output format and
  resolution options KIE added.
- MachGen GPT Image 2.6 qualities now come from MachGen's published model
  surfaces. No value Videobook offered was withdrawn: MachGen refuses xhigh
  and max on GPT Image 2, which Videobook never sent.
- Image and video generation pick a **Model** and a **Provider** in two
  selects: in the cell editor, the chat generation review, the generate image
  and video forms of the Actions sheet and the fullscreen image editor.
  **Model** lists each model once with its leaderboard rank and Elo, however
  many providers offer it, and folds variants such as Seedance 2.0 US or H3
  Max Turbo into their model. **Provider** lists who offers the chosen model,
  with the variant and price, marks one that is not configured or cannot take
  the inputs, and is disabled when there is only one. Changing the model
  keeps the provider when it offers the new model, and every option the
  single list offered can still be chosen. `list_generation_models` and
  `list_notebook_actions` rows gain `family` and `variant`, and
  `list_image_edit_models` rows gain `family`, `variant` and `frontier`.
- A new GEN IMAGE or GEN VIDEO cell starts on the model, and so the provider,
  of the last image or video generated in this book, in any notebook and
  after a restart, instead of the default model. That covers the add menu,
  dragging to create, the canvas **Generate image** and **Generate video**
  items, `create_notebook_cell` without a model and chat generations. Runs
  from the cell editor, reruns, chat and slash commands set it; goal and
  chain steps, extend, upscale, lip sync, motion control, layering and
  fullscreen image edits do not. A remembered model that is hidden, retired,
  not configured or unable to take the cell's inputs falls back to another
  endpoint of the same model on the same provider, then to the default. An
  explicit model always wins. It is kept in the book setting
  `generation-model-memory`, and notebook payloads such as `get_notebook`
  carry it as `generation_model_memory`.

### Fixed

- Exact subject edits work again. KIE moved the Grok Imagine Image 2.0 edit
  of selected subjects to a new segment-edit model and refused the old
  request, so every exact edit failed. Edits now use segment-edit with the
  same subject indexes, and an edit already waiting on KIE resumes.
- New tiles stay in view. A download, a generation's output or another tile
  you create scrolls into view between the top of the canvas and the
  composer's open panel, which then closes unless a voice conversation is
  live. A successful composer command used to scroll to the bottom of the
  notebook, so a download landing at @a1 in a new book left row a out of
  view, and a generation's output was shown only when its source tile was
  selected. Tiles created by other clients leave the scroll alone.

## [0.8.2] - 2026-11-19

### Fixed

- A job writing an asset's media files keeps the asset until it finishes: the
  asset no longer shows as ready after the first file, and a retry cannot start
  on it mid-work. Installs are smaller, as the storage engine no longer depends
  on node-gyp.

## [0.8.1] - 2026-11-19

### Added

- WaveSpeed image models: GPT Image 2.6 Sunburst and Flare for text-to-image
  and edits, GPT Image 2.5 Sunburst and Flare and GPT Image 2 for
  text-to-image, Nano Banana 2.1 for text-to-image and edits of up to 14
  images, Grok Imagine Image 2.0 for text-to-image, and Seedream 5.5 edits of
  up to 10 images. GPT Image 2.6 edits take up to 16 images plus a Mask or a
  Markup image, not both, and return PNG, JPEG or WebP. Each is priced before
  it runs and recorded as image usage.
- WaveSpeed video models: Gemini Omni 1.2 Flash text-to-video, references (up
  to 10 images and 3 videos) and video edit, SkyReels V4 text-to-video, P-Video
  2 Pro with a first and optional last frame, and HeyGen Video 1.0
  image-to-video. A Gemini Omni 1.2 edit follows its source video's length and
  is priced on it. SkyReels V4 refuses sound in fast mode before creating work.
- MachGen GPT Image 2.6 Sunburst and Flare for text-to-image and edits of up to
  16 images, with a quality from low to max (default high) that sets the price.
- Nunchux as a new provider, with its key `NUNCHUX_API_KEY` in Settings. It
  brings Nano Banana 2.1 for text-to-image and edits of up to 14 book images,
  Wan 3.0 for text, frames and references, Wan 2.7 and HappyHorse 1.0 video
  edits, Seedance 2.5 and 2.0 for text, frames and references, and MiniMax H3
  for text, frames and references. Each is priced before it runs, including a
  Seedance first frame from the book, and appears in the pickers with its
  leaderboard rank. A Nano Banana edit takes images from the book, not URLs.
  Nunchux's other model ids have no published price yet and are not offered.
- `/goal` starts every new short with an initial analysis before anything is
  generated. It reads the source video's scenes and sampled frames, applies
  this book's saved goal defaults unless the brief says otherwise, picks a
  frame where the action happens (`@a1 at 3s` still pins one), and saves a
  recipe: keep the source shots, regenerate the video or make one continuous
  take; add the character or replace someone; when the action starts and ends;
  source graphics, sound, branding, estimates and open questions. The Recipe
  step shows it with choices you can change. **Use these defaults for this
  book** saves them for later goals without starting a paid run, and **Refresh
  analysis** runs it again. Over MCP, `video_goal` gains `analyze` and
  `save_defaults`, and the plan holds the recipe in `analysis`.
- A remix goal can remove the source video's burned-in graphics before it
  generates anything. The Recipe step proposes removal regions; review them and
  run them locally with LaMa or fast fill, or reuse an earlier cleaned copy
  made with the same regions and method. Physical signs and printing stay.
  Once you have watched the prepared video and confirmed it with **Use reviewed
  source**, both the image and the video references come from it, and a later
  goal reuses a matching reviewed copy. `video_goal` gains `prepare` and
  `review_source`.
- A remix that keeps the source's shots generates only the interval that
  changes. On the Video step, drag the window of the generated take until it
  holds the whole action and payoff, then **Use this window**; Finish puts that
  window back between the kept source frames, at the source's frame rate.
  `video_goal` gains `review_action` with `start_seconds`.
- A remix goal takes several character images: drag notebook images or image
  files onto Character references, up to 12, and give each one its role in the
  replacement prompt with `@image1`, `@image2` and so on. `video_goal` `update`
  saves their order in `sourceImages`.
- A goal keeps every take of its steps, from approvals, manual reruns and
  related goals, with the prompt, references, model, outcome and cost behind
  each. The takes button in the panel's header lists them, and **Use reviewed
  take** (`video_goal` `adopt`) selects one, also from a cancelled goal; a
  manual rerun never changes the selection by itself. Approving an image step
  reuses an earlier reviewed image with the same prompt, settings and inputs
  instead of paying for it again.
- New goals check each selected frame, clip and final render locally when it is
  ready: that it decodes, that its inputs are current, its duration and frames,
  and the final assembly and sound. **Review against brief** is an optional
  paid review of identity, added overlays, action and reveal timing on sampled
  frames. Its full image-input price is unknown, so it runs only when you ask,
  and unchanged media reuse the saved result. These checks replace **Check for
  AI tells** on new goals; goals saved earlier keep it. `video_goal` gains
  `check_output`, with `semantic` for the paid review.
- Automatic continuation for a reviewed goal: turn on **Offer automatic
  continuation for this recipe**, set a USD allowance and click **Run reviewed
  recipe**. This approves the saved recipe and the selected images, then runs
  the remaining steps with their checks, assembly, sound and branding up to a
  final preview; it never posts. It stops for new images, source and action
  reviews, failed or unverified checks, changed inputs, unknown or lower-bound
  prices (an H3 Max video still needs a manual approval), account errors and an
  allowance too small for the next step. **Pause automatic continuation** stops
  further submissions, and spend, reservations and the remaining allowance
  survive reloads. The allowance is checked against estimates, not a provider
  billing cap. Importing a book pauses such a goal: it spends again only after
  `auto_continue` in the new library, not when the book's schedules resume.
  `video_goal` gains `auto_continue` and `pause_auto`.
- A failed video download can be recovered in its own cell. Select the cell to
  see why it failed, then **Retry download**, or **Choose video file** to
  import a saved copy into the same cell; a TikTok post that needs sign-in also
  offers **Open TikTok post**. Set `VIDEOBOOK_YTDLP_CHROME_PROFILE` to a
  dedicated Chrome profile signed in to TikTok to get **Retry with Chrome**
  (`retry_job` `use_chrome_profile`), and add
  `VIDEOBOOK_YTDLP_CHROME_ON_LOGIN=1` to have a TikTok link you add try that
  profile once by itself when TikTok asks for sign-in.

### Changed

- Every @apicity package moves to 0.28.1.
- The model pickers use the 2026-11-16 leaderboards. The new WaveSpeed and
  MachGen models carry their ranks; Nano Banana 2 leaves the text-to-image
  board, so fal's hidden Nano Banana 2 leaves the picker again, and Kie
  Seedream 5.5 text-to-image and Runway Aleph 2 lose their ranks.
- fal MiniMax H3 Max and H3 Max Turbo estimates use the card's list rates, so
  they rise: a 12-second 1080P H3 Max clip now estimates $1.92 instead of
  $1.344.
- The GPT Image 2.6 prompting guide covers its WaveSpeed and MachGen controls.
- The goal panel shows one next step at a time. A step strip (Recipe, the
  stages, Finish) gives each step a thumbnail and its status in words, and a
  NEXT bar says what to do next, why it is blocked and what it costs, and holds
  the only primary button. The panel opens on that step and follows the goal as
  it moves on. Stop, Retry and Save sit in the bar, the takes and a ⋯ menu
  (Discard goal, Dismiss) in the header, and image steps show before and after
  with Revise and New take priced beside them.
- In a new remix goal the Twist step becomes Action setup: its image edit sets
  up the people and props for the action the brief asks for, instead of adding
  one funny visual change.
- A goal finishes with the sound and branding saved in its recipe. A remix
  keeps its original audio on the source's timeline, trimmed or padded with
  silence to the final length, and mutes generated sound unless **Generated
  sound** or **Mix original and generated** is chosen. The saved branding keeps
  its template or starter, handle, image layers, placement and timing, and
  **Use current book branding** adopts a look saved later. `video_goal` gains
  `refresh_finish` for that, and with `audio_artifact_id` and
  `audio_start_seconds` it picks another soundtrack. A sound or branding change
  reruns only Finish, and a failed finish keeps its working copy so it can be
  retried without making the video again. Goals saved earlier keep their
  settings until they are edited or analyzed again.
- Notebook cells are 240x200, and their rows resize so four fit in the window.
  The from/to pills are gone: a cell's inputs hang off its top edge as a badge
  with one segment per source, the slot it fills (I1, V1, FF) or, for a
  producer link, the source's family icon, and its outputs hang off the
  bottom-right corner, naming up to two targets. Media tiles keep the picture
  clear and put the address, metadata and menu in a footer strip that drops
  whole items when it is narrow, with audio badges whole beside the duration;
  the producer chip leaves the media rail.
- On a desktop 1200px or wider, the graphics editor's chat log sits beside the
  sheet and the preview fills the middle column. Text, look, frame, layers and
  the selected layer's settings share one scrolling column on the right, Guides
  and Snap sit under the preview, and selecting a layer scrolls its settings
  into view.
- Local graphics removal runs in its own process instead of inside the server,
  and the remover shows how many frames are done; `remove_video_graphics`
  `status` returns `progress`.
- fal MiniMax H3 Max reference-to-video measures each video reference before it
  creates work and refuses one outside 2-15 seconds, or more than 15 seconds
  together, so a video reference must be in the book, not a URL.
- A fal upload refused for authorization, an insufficient balance or a blocked
  account fails with that error instead of moving on to the free upload hosts.

### Fixed

- One book whose catalog cannot open, such as a book moved under another
  book's directory, no longer stops the server from starting. The other books
  open, a duplicate name fails only the later book, `/healthz` lists each
  unavailable book with its directory and cause, and `videobook doctor` warns
  about them. After repairing a directory, run `reopen_books`
  (`/reopen-books`) to rescan the library and open it.
- With B2 configured, each book keeps its media under
  `<VIDEOBOOK_OBJECT_PREFIX>/books/<bookId>/`, so Forget in one book no longer
  removes a file another book's backup still counts as published. A book
  backed up earlier still reads the shared prefix, and its next `storage_sync`
  copies each object into its own; `storage_status` reports `pending` until
  then, and `incomplete` with `missingObjects` when the bytes exist nowhere.
  Forget deletes a shared copy only after every other book holding the same
  bytes has its own.
- Forget erases every stored file of the asset, listed from the catalog
  including older originals from its revisions; a missing thumbnail no longer
  leaves the files in place while Forget reports success. A file it cannot
  erase stays listed: `delete_asset` `forget` returns status `incomplete` with
  `pending_objects` and the error, the app shows that as an error and offers to
  try again, and repeating the call with the same `asset_id` finishes it.
- Several crops or pads started at once in one book no longer stall until they
  time out: a crop derives its image variants, and a pad reprocesses its video,
  inside its own job, so each needs one worker.
- Opening another video's graphics no longer drops an edit made just before
  the switch. A save that fails or conflicts when you switch or close is kept,
  and reopening that video restores it with Retry, Reload and Keep my version.
- Chat text for the video already open in the graphics editor lands as one
  undoable edit instead of reloading the editor and dropping unsaved changes.
- A watermark burned from a saved template draws the template's image layers,
  such as a logo, instead of leaving them out.
- Downloading a finished generation from its provider retries a network error,
  an attempt longer than two minutes, a 408, 429 or 5xx response, or an empty
  file up to two more times.
- A generation that fails because fal's file storage refused an upload shows
  fal's reason after the status code, in the failure and in
  `inspect_generation_request`.

## [0.8.0] - 2026-11-16

### Added

- Remove burned-in titles, subtitles and graphics locally with
  `/remove-graphics` (also `/remove-osg` and `/remove-titles`). PaddleOCR
  proposes text regions with editable boxes and time windows; non-text logos
  can be marked manually. LaMa inpainting or fast FFmpeg fill produces a new
  video copy with audio, leaving the original intact. The AI models download
  once with checksum verification; processing needs no API key or media upload.
- `/zoom` and `zoom_video` zoom toward a chosen point, ease in, hold and
  optionally return, with up to eight timed zooms. The Actions sheet previews
  the motion and lets you pick the focus point directly on the picture.
- Ten free, locally synthesized sound effects, including whoosh, pop, ding,
  impact and zoom sounds. Preview them in the Actions sheet, mix up to sixteen
  cues into a video with `apply_builtin_sfx`, or attach sounds to a zoom.

### Changed

- New goals based on a video use separate Replace character, Twist, Video and
  Finish stages. GPT Image 2.6 edits a locally extracted frame, then makes the
  reviewed twist; MiniMax H3 Max receives both the original video for motion
  and the twist image for appearance. Each paid stage has its own review and
  estimate. Existing storyboard goals keep their saved workflow.
- Chat URL downloads import the whole clip without an approval preview.
  Direct MCP calls retain explicit range options. Audio extraction in chat
  and voice also runs without an approval preview, with ranges still supported.

### Fixed

- Retrying a failed crop or timewarp clears the stale failure before claiming
  the asset, so the retry can start.
- Preserve source-video and reviewed twist references when generating a goal's
  video, and show both references before generation.

### Known limitations

- Local AI graphics removal processes each region of each frame on the CPU.
  It can be slow, briefly delay server responses, and flicker on moving or
  detailed backgrounds. Frame progress and a completion estimate are not yet
  displayed. Fast fill is available for simple backgrounds.

## [0.7.5] - 2026-11-15

### Fixed

- Reduce idle server CPU and database reads across book libraries by updating videobook-engine to 5.9.2.

## [0.7.4] - 2026-11-14

### Added

- A storyboard frame whose clean-up failed offers "Clean with" the other
  clean-up model, Nano Banana 2.1 for a Seedream 5.5 frame and Seedream 5.5 for
  a storyboard saved on Nano Banana, with its own price, and "Try again with"
  the same model. Versions from both models stay selectable.

### Changed

- A short made from a video removes its storyboard's on-screen graphics with
  Seedream 5.5 Edit on Kie instead of Nano Banana 2.1, so it needs a Kie key
  (`KIE_API_KEY`), and the Storyboard step shows a real price per frame. Each
  frame keeps its aspect ratio and resolution. A storyboard saved earlier keeps
  cleaning with Nano Banana 2.1.

### Fixed

- OpenAI and xAI structured text refusals name the model and retain refusal details through chat and queued jobs; chat does not retry a refused request.
- Fal content-policy refusals name the model, explain how to revise the request, and settle at zero cost.
- When the clean-up of one storyboard frame of a short fails, for example
  because the model refuses it, the other frames are still cleaned and the goal
  stays open on the Storyboard tab instead of failing. The failed frame shows
  its error with its own Regenerate and Revise, a frame that never ran says why
  instead of "Not cleaned yet", and the goal tile names how many frames failed.

## [0.7.3] - 2026-11-14

### Changed

- The default TikTok watermark places the handle above the title as solid text with a shadow, without a pill or border.

### Fixed

- Graphics, reframed, stacked, batch and subtitle renders give the new video
  the transcripts of the video it was rendered from instead of queuing a paid
  speech-to-text call for it; a render of an untranscribed video, or one whose
  length changed, is left for you to transcribe. Burning a watermark in place
  and cropping keep the video's transcripts too.

## [0.7.2] - 2026-11-14

### Added

- On-screen graphics can move as well as fade. Each layer has an Enter and an
  Exit choice: Fade, Slide (in from and out to the nearest frame edge), Pop
  (growing from 85% as it fades in), and, for text, Words (the words appear one
  after another). The fade length sets how long each move takes. The editor
  preview and every render move the same way, and layers left on Fade burn
  exactly as before.
- One render can draw subtitles and graphics together. The graphics editor's
  render has a With subtitles switch, with a language choice when the video
  has several subtitle drafts, and the subtitle editor's render has a With
  graphics switch. Either makes one new cell, or a new version of it, with one
  video encode and the subtitles on top. Over MCP, `video_graphics` `render`
  takes `with_subtitles` and `subtitles_revision`, and `caption_video`
  `render` takes `with_graphics` and `graphics_revision`.
- The graphics editor's Frame control reframes the video to 9:16, 1:1, 4:5 or
  16:9, either cropped around a focus point you drag or filled out with a
  blurred copy of the video. The preview and the render lay the graphics out on
  that frame, and a reframed render always makes a new cell (1080x1920,
  1080x1080, 1080x1350 or 1920x1080). With subtitles on, the subtitle draft's
  frame and background are used.
- A graphics template can be applied to up to 50 videos at once: select video
  cells and choose Apply graphics template from the cell menu, or run
  `/apply-graphics-template`. Each video keeps the text typed into its slots,
  its own credit and handle, and its frame, and with Render into new cells (on
  by default) gets its own new cell. A video that fails is reported by itself
  and the others go on. Over MCP this is `video_graphics` op `apply_template`.
- A `/goal` short's Finish tab has a burned title: a Thai headline and an
  English line under it, burned into the watermark's title block when the short
  finishes. Type it, or click Write title, which shows its estimate first and
  makes one text call (asked again once when the answer is not a Thai headline
  with an English line within the slot limits) for three options from the
  short's brief, title, beats and source images to pick from and edit.
  `video_goal` gains the `title` action, `update` stores the title in
  `plan.finish.title`, and a changed title finishes again from the reviewed
  take. A short without a title, or whose saved TikTok watermark template has no
  headline, finishes as before.

### Changed

- `/goal` shorts have no main character. Every image a brief mentions is a
  source image kept as photographed, up to 12, and a brief with no image plans
  the person from its own words. New shorts have no Character tab, and
  `video_goal` has no `character` action. Shorts saved with a character keep it
  read-only and still run and finish with their stored prompts.
- The first video a `/goal` brief mentions becomes the short's storyboard
  instead of one midpoint frame: 4 frames by default, one per shot when it has
  cuts, starting at `@a1 at 3s` when given, captured at no cost. A Storyboard
  stage and tab come before the frame: one estimated Nano Banana 2.1 edit per
  frame removes captions, stickers, logos, credits and shade, and each clean
  frame can be regenerated, revised or set back to an earlier version. The
  planner follows the storyboard's action and camera with the brief's changes,
  the opening frame is made from the source images and clean storyboard frame
  1, and clips never receive storyboard frames.
- `video_goal` `approve` refuses a stage other than the one under review.

### Removed

- Removed `set_video_overlay`, the render-time image overlay, `render_video`'s
  `osg_*` arguments, and `apply_watermark` mode `overlay`. External callers get
  unknown-tool or invalid-argument errors. Use the graphics editor or watermark
  burn instead. Stored overlay render settings are ignored; saved watermark
  profiles with mode `overlay` use `burn`. `render_video` keeps subtitles and
  keyword graphics and does not draw graphics documents.

### Fixed

- The `/goal` planner names a mentioned image or video by the address it had
  when the brief was typed, so the goal's own notebook layout no longer points
  a mention at the wrong cell.
- Subtitle renders, `render_video` and QR outros first check that the host's
  hardware H264 encoder can really encode, and render in software when it
  cannot, so a host that advertises an encoder it cannot load no longer fails
  these renders.

## [0.7.1] - 2026-11-13

### Added

- Kie GPT Image 2.6 Sunburst and Flare, for text-to-image and edits, beside the
  fal endpoints. Edits take up to 16 images plus either a mask or a markup
  image connected to the Markup input, not both. Output is PNG, JPEG or WebP;
  the GIF and SVG formats Kie also offers are left out, as they are on fal. Kie
  bills these models by tokens no request shows, so their estimate stays $0 with
  Apicity's warning until the task reports its cost.
- Kie Gemini Omni 1.2 Flash as one model with four modes: text, frames (a first
  frame and an optional last frame), up to six reference images, and Edit video.
  Clips run 3-15 seconds, and frames default to 10 seconds, the most a clip with
  a last frame can run. An edit sends no duration, follows its source video's
  length and is priced on that length.
- Kie Seedream 5.5 for text-to-image, edits of up to 10 images and layer
  decomposition. Layer decomposition returns up to `max_images` images (30 by
  default) and is estimated at that cap, an upper bound.
- Kie MiniMax H3 Image for text-to-image and edits of up to 16 images. Edit
  prompts name connected images `<Picture 1>`, `<Picture 2>` and so on. Images
  are sized by resolution tier and aspect ratio.
- Kie Kling 4.0 Flash keyframe-to-video and reference-to-video, at 720p for 3-20
  seconds. Keyframe-to-video starts from text or a first frame.
  Reference-to-video takes up to 10 images and 5 videos, and refuses book videos
  that run longer than 20 seconds together before creating work.
- KIE Image Upscale, by a factor of 1, 2, 4 or 8, and KIE Video Upscale, into a
  1080P, 2K or 4K box. An image upscale of a book image is priced at the tier
  its stored size reaches; without a known size the estimate quotes the 8K tier
  and says so. A video upscale is priced on its source's seconds.

### Changed

- `/goal` accepts video references by extracting a frame locally for free,
  skips unusable mentions, and keeps the first 12 usable images. The review
  panel explains each adaptation. Lengths are clamped to 5–60 seconds, extra
  quoted beats are fitted or folded in, and a missing OpenAI key produces a
  reviewable plan from the brief. Revise feedback accepts @mentions and up to
  2000 characters. Video character references also use extracted frames, and
  a character without reference images can generate a frame from its saved
  name and description. Paid generation keeps its approvals and estimates.
- `/goal` shorts no longer start with a cold open; Finish keeps the reviewed
  take and burns the saved watermark. To add a cold open, use
  `/edit-cold-open` on the finished video.
- A new `/goal` short opens on its Character tab, and the tab you choose stays
  open while the short updates. The Character tab shows the notebook's images,
  the ones the brief mentioned first, and takes an upload: pick up to four to
  use as they are, or to make the character sheet from. A sheet made from
  pictures keeps that person's face, hair, build and clothes.
- Download actions and `/download` in a non-loopback browser now save the
  original file through the browser. Local pages and direct MCP Downloads
  exports keep copying to the server Downloads folder.
- The model pickers rank the new Kie endpoints: GPT Image 2.6 on both image
  boards, Seedream 5.5 for text-to-image and edits, and Gemini Omni 1.2 Flash
  for text-to-video, references and video edits. Kie Wan 3.0, Wan 3.0 Prime and
  Seedance 2.5 also carry their video-editing ranks; Wan 3.0 edits a video
  connected in its References mode.
- The GPT Image 2.6 prompting guide covers its Kie controls beside fal's.
- Every @apicity package moves to 0.28.0. Apicity drops KIE's withdrawn
  Midjourney calls, which Videobook never used.
- `@hono/node-server` resolves 2.1.8, and the dependency override now requires
  at least that version. 2.1.7 fixed `serveStatic` with `allowPercentInPath`,
  which Videobook does not use: Express serves its files and the MCP endpoint
  uses only Hono's request listener.

### Fixed

- An image the brief mentioned that then becomes the main character is no
  longer also sent as a place or prop reference when the short's frame is
  approved.

### Removed

- The `video_goal` tool no longer accepts `start_seconds` or `end_seconds`.

## [0.7.0] - 2026-11-12

### Added

- `/goal` makes a short: a real-looking phone video of 5 to 60 seconds starring
  the book's main character, who never speaks. A brief needs no @mention;
  mentioned image cells become place or prop references for the opening frame.
  The goal panel reviews it in four steps, Character, Frame, Video and Finish,
  and every paid step has its own approval and estimate. The frame uses GPT
  Image 2.6 and the clips MiniMax H3 Max through fal (`FAL_API_KEY`); planning
  and revising use `OPENAI_API_KEY`.
- Revising a short's frame or clip rewrites that frame prompt or beat with the
  feedback before the paid step, replacing any sentence the feedback
  contradicts, and saves it in the short. The clips' rule line films the phone
  footage from someone off screen, and planned beats call the camera the camera,
  so the main character holds a phone only when the brief gives him one.
- A main character saved per book, by default "a man in a green shirt", with
  image cells or a GPT Image 2.6 character sheet as his references
  (`video_goal` action `character`).
- Shorts longer than 15 seconds continue in up to four H3 Max Extend clips, one
  approval each; Add a beat appends one up to 60 seconds.
- `video_goal` action `check` looks at a frame or a clip's new footage for AI
  tells and lists up to five advisory findings. It runs only when asked and
  never blocks a step.
- `generate_video` takes `transcribe: false` for footage with no speech. The
  video is processed without the automatic speech-to-text pass, keeps that
  choice when it is processed again, and `reconcile_project_work` does not
  backfill a transcript for it. A short's clips, continuations and finished
  video are made this way. Imported and recorded videos are transcribed as
  before.

### Changed

- Goals saved by earlier versions are read-only tiles. Their status lists
  their outputs by address and their finished video; they answer `list`,
  `status`, `cancel` and `dismiss`, and one still planning, in review or
  running is stopped on its first read. Nothing in the book is deleted.

### Removed

- The `assemble_goal` tool and the `assemble_goal` and `combine_goal` jobs.
- The `video_goal` actions `assemble` and `combine`, the `shot_indexes`
  argument, the `storyboards` stage, and plan versions 2 and 3 in `plan`: Goal
  mode no longer offers styles, storyboards, ending frames, multi-clip
  assembly, combined videos, Nano Banana scenes or Seedance clips.

### Fixed

- A generation step in a notebook chain fails with the provider's message when
  the generation fails or its output times out. The step and the run used to
  report completed with an asset that had no media.

## [0.6.2] - 2026-11-11

### Added

- fal GPT Image 2.6 Sunburst and Flare, for text-to-image and edits. Edits
  take up to 16 images plus either a mask or a markup image, a transparent PNG
  of circles, arrows and notes connected to the new Markup input. A mask and a
  markup image cannot be combined. Output is PNG, JPEG or WebP; the GIF and
  SVG formats these endpoints also offer are left out because a book image is
  stored as one of those three.
- fal Gemini Omni 1.2 Flash for text, frames, references, edits, extensions
  and upscales. Clips run up to 15 seconds. Frames with a last frame stop at
  10 seconds, which is the default length there. Extend continues a connected
  video by 3-10 seconds, and upscale re-renders one at 720p, 1080p or 4K.
- fal Seedance 2.0 Mini for text, frames and references at 480p and 720p,
  priced from the @apicity/cost token formula at $0.007 per 1,000 tokens.
  References that include a video or audio clip have no published price yet,
  so their estimate stays unpriced and says why.

### Changed

- Every @apicity package moves to 0.27.3.
- MachGen MiniMax H3 Turbo takes 1-15 second clips; it used to start at 4.
- The model pickers rank by the 2026-11-11 top-10 boards. GPT Image 2.6 leads
  both image boards, Gemini Omni 1.2 Flash is ranked for text-to-video,
  references and video edits, and HeyGen Video image-to-video is now ranked.
  The Kie Grok Imagine Video 1.5 preview moves to the unranked group. Hidden
  models are listed only while they are on a board, so KIE and fal GPT Image 2
  Edit, fal GPT Image 1.5, KIE Seedream 5 Pro Edit and fal Wan 3.0 and Wan 3.0
  Prime image-to-video leave the picker again. They can still be called by id.
  GPT Image 2.6, Gemini Omni 1.2 Flash and the other dynamically priced fal
  models use fal's historical per-call average when `FAL_ADMIN_API_KEY` is set.

## [0.6.1] - 2026-11-11

### Changed

- The graphics editor takes less room and shows more of itself at once. One
  header row carries undo, redo, the save state and the render output beside
  Render and Close; templates are one toolbar row; the quick fields sit beside
  an inspector that shows one section of the selected layer at a time; and the
  layer list and the timing strip are one timeline, with a seconds ruler that
  scrubs the preview and handles that trim the selected layer. The transport
  under the preview is play, time and mute, so it no longer runs into the
  controls. Suggested headlines and translations list beside the fields
  instead of pushing them down.
- The Credit field edits the handle a look draws when the look has no credit
  line, so the field and the preview show the same text.
- The default look (TikTok title) carries the handle as the first line of the
  title block, above the headline and for the whole clip, instead of a
  separate chip at the top for the first seconds. Videos with saved graphics
  keep theirs, and the watermark that `apply_watermark`, goal finishing and
  `/watermark` burn is unchanged.

### Fixed

- Graphics and subtitle renders made as a new video now go through video
  processing like every other new video. The new cell plays a lighter preview,
  and the copy gets analysis frames, its audio as MP3 and a waveform, so
  watermark placement and analysis can read it and `doctor` with `fix: true`
  reports it healthy instead of rebuilding it. Renders made before this change
  get the same files from `doctor` with `fix: true` and their `asset_id`.
- Regen post in the post sheet (`draft_post_copy`) no longer fails with "No
  frames to analyze" on a graphics or subtitle render made as a new video.
  `analyze_video` now extracts and keeps the frames of a video that has none
  stored before it analyzes it, so renders made before this release can be
  analyzed without a `doctor` fix first.
- The Actions sheet reviews `video_graphics` and `caption_video` by the
  operation chosen in the form instead of warning about charges for every
  one. Only the paid operations (`suggest` and `detect_regions` for graphics,
  `prepare` for subtitles) say they may incur provider charges and show a
  cost estimate; deleting a template, rendering with `output: replace` and
  discarding a subtitle draft say they change or remove content; every other
  operation shows neither. A paid action whose cost cannot be estimated shows
  "Cost estimate unavailable" without the estimator's internal "no cost
  adapter registered" message.

## [0.6.0] - 2026-11-11

### Added

- `video_graphics` takes `op: render` with `expected_revision`, `source_hash`,
  `request_id` and `output` and burns the reviewed graphics into the video in
  the background. `output: new` (the default) writes a copy into a new video
  cell below the source, and a later render adds a version to that cell;
  `output: replace` rewrites the source video, keeps its earlier version in
  history and clears the saved graphics. Each layer shows only inside its time
  window with its fades. A retry with the same `request_id` returns the same
  render, and `get` reports the latest render and any graphics already burned
  into the video.
- `/overlay @a1` (also `/osg` and `/graphics`) opens a graphics editor in the
  composer: a live preview of the video with its graphics, quick fields for
  the headline, second line and credit (the downloaded clip's credit is
  offered), starter looks that keep the text already typed, autosave with
  undo and redo, and Render into a new video cell or in place. A video
  without graphics starts from the default look: the TikTok handle, a big
  Thai title and an English line under it. `/overlay @a1 @b2` adds the image
  as a layer at the top left of the safe area. Opening the editor on a copy
  that already has graphics drawn in offers its source instead.
- Graphics templates, saved per book. The editor's template row lists the
  starters and the book's saved templates: save the current look under a name
  (its headline, second line, credit and handle are left empty, so each video
  keeps its own), apply it to another video while keeping the text typed
  there, update, rename or delete it, and make a template or a starter the
  look that videos without graphics start from. Templates can be copied from
  another book together with the images their layers use; a template whose
  image was deleted stays usable and reports that layer as missing.
  `video_graphics` takes `op: save_template`, `rename_template`,
  `delete_template`, `set_default_template` and `copy_templates`, and `get`
  returns the book's templates and `default_template_id`.
- The graphics editor lists the layers and edits the selected one in an
  inspector: add text, an image from the book, a QR code or a shade; rename,
  show or hide, reorder, duplicate or delete a layer; place it on a
  nine-point grid inside the safe area, the inset frame or the whole frame;
  and set its opacity, its size and, for text, the width, alignment, backing
  plate and each line's text, slot, icon, font, size, colour, case, line
  limit, accent stroke, outline and shadow. Graphics also opens from the
  video cell menu, the media dock and typed or spoken chat, which can fill
  the headline, second line and credit; nothing renders until Render is
  pressed.
- Layers drag, resize and snap to the safe area, the centre lines and the
  other layers on the preview (Alt, Ctrl or Command moves freely). Arrow
  keys nudge, Delete removes and Ctrl or Command+D duplicates, each as one
  undo step. Each layer has a time window (the whole clip, the first or last
  N seconds, or a custom window from the playhead) with a fade, shown on a
  strip under the transport, and the render shows the layer only then.
  Under 900 px the editor stacks and takes touch drags.
- Suggest on the headline field offers 3 to 5 headlines (Thai by default)
  written from the video's existing analysis, transcript and download text,
  and Translate on the second line offers translations of the headline
  (English by default). Each press is one paid model call; it never starts
  transcription or analysis, and nothing is applied until an option is
  picked. `video_graphics` takes `op: suggest`.
- The layer list warns when a layer covers a face or on-screen text already
  found in the video while it is shown, and Find clear spot in the inspector
  moves the layer to the clearest of its nine spots as one undoable step. It
  is free when the layer's frames were already checked and says when it
  needs a paid vision check first. `video_graphics` takes
  `op: check_placement` and `op: detect_regions`.

### Changed

- `/overlay` no longer opens the render-time overlay form. The
  `set_video_overlay` tool still works for `render_video` outputs.
- `/watermark @a1` and chat watermark plans open the graphics editor in
  watermark mode: the platform's watermark (for TikTok the handle, an empty
  Thai title and an English line, no QR code), a TikTok/X switch, Replace
  video as the default output, and Save as default watermark, which
  `apply_watermark` and goal finishing then burn. A chat plan's platform,
  handle and QR choice open in the editor, where position, opacity and
  timing are set. The separate watermark review is gone. `video_graphics`
  takes `watermark: true`, `op: save_watermark` and
  `op: set_watermark_template`.
- `apply_watermark` burns and goal finishing draw the watermark with the
  graphics renderer, and `include_qr` defaults to false: the default TikTok
  watermark is the handle alone until a title is typed or a saved watermark
  template adds more. `include_qr: true`, or a saved watermark template with
  a QR code, adds the QR code back, and it still decodes to the profile URL.
  A saved watermark template can carry a headline, a credit
  (`source_asset_id` fills it from another video) or a logo, and
  `card_asset_id` draws as an image layer. `wait: false`, `position: auto`
  and the saved profiles behave as before.

### Fixed

- A downloaded video keeps its source URL, platform, uploader, title and
  description after an in-place edit such as a trim, crop, watermark burn,
  in-place subtitles or graphics. The graphics credit is still filled for it,
  and its source link still reaches chat. The edit is still recorded as the
  video's latest origin.

## [0.5.1] - 2026-11-10

### Added

- `video_graphics` MCP tool with `op: get | update` for the on-screen
  graphics drawn over a video: text blocks, images, QR codes and shades, each
  with a position, size, opacity and time window. `get` reads the saved
  layers, or for a video without any the default look (the book's TikTok
  handle, an empty Thai title and an English line, no QR code), with the
  handle, profile URL and source credit that fill its slots and the starter
  layouts. `update` saves edits or a replacement document against
  `expected_revision` from `get`, and a stale revision comes back as a
  conflict that carries the current one. Saved graphics are not drawn into
  the video yet.

### Changed

- Gemini Omni references, Grok Imagine Video 1.5 references and Kling o3
  prompts name connected inputs with each provider's documented markers:
  `<IMAGE_REF_0>` and `<VIDEO_REF_0>` for Gemini Omni on fal and WaveSpeed,
  `<IMAGE_0>` for Grok 1.5 on fal, WaveSpeed and xAI, `<<<image_1>>>` and
  `<<<video_1>>>` for the Kling o3 edit on WaveSpeed, and `@Image1` and
  `@Video1` for Kling o3 on fal. Notebook prompts keep their `@image1` slot
  mentions.
- MachGen Topaz upscales are priced with MachGen's free quote instead of
  showing $0. `estimate_cost` and notebook plans quote an upscale of a MachGen
  output when `MACHGEN_API_KEY` is set, and every Topaz job is quoted when it
  submits, so its usage row keeps the quoted estimate beside the billed
  charge. A video MachGen must upload is quoted only at submission, and a
  failed quote leaves the estimate unpriced as before.
- Every @apicity package moves to 0.27.2. MiniMax H3 Max extend, insert and
  reference videos are quoted from their duration and resolution at the
  published per-second rate instead of fal's per-call average, so a 2K extend
  of 5 seconds quotes $1.60 and one of 15 seconds $4.80 instead of $0.32.
  Reference tokens are not counted, so the generation editor, plans, Jobs
  rows, chain steps and cell costs show the quote as "at least" the figure
  with the reason. H3 Max 3D and lip sync are quoted the same way when the
  source length is known. FLUX 3 Max video estimates follow fal's current
  promotion: $0.085 a second at 720p and $0.145 at 1080p.
- fal models quoted from fal's historical per-call average keep that quote
  beside the billed charge once fal reports the call's billable units, so cell
  and run totals set the estimate against the actual. The generation payload,
  plans, chain review and usage rows say the figure is a per-call average, not
  this request's price.
- Thai subtitles use a bundled Noto Sans Thai (OFL) instead of a subset
  downloaded from Google Fonts, so they render without network access.

### Fixed

- Subtitle renders, `render_video` and QR outros no longer fail on Linux hosts
  without an NVIDIA GPU. Remotion picked the `h264_nvenc` encoder there even
  without `libcuda`, so every render job failed; a render now falls back to
  software encoding when a hardware encoder cannot open and stays in software
  for the rest of the process, while hosts where hardware encoding works keep
  using it.
- A generation cell's cost breakdown no longer covers the Inputs, Model and
  Payload panels of its editor once the cell has three or more provider calls.
  The editor keeps its minimum height, and the per-call list is folded behind
  an "N calls" disclosure that scrolls inside the dock when opened. A cell
  with no recorded calls no longer shows an empty separator.
- A fal call that fal reports as 0 billable units, such as a request it
  rejects when the result is read, settles at $0.00 instead of staying at its
  quote for good, so cell, run and book totals are no longer left partial. A
  failed call shows as "Failed, not billed" with fal's reason, the book usage
  list says "Not billed", and `list_jobs` returns each job's `notBilledCalls`.
- A fal result that comes back without its billable units, as when it is read
  hours after the job finished, labels that call "Awaiting bill" instead of
  "Estimate". A later read that carries the units still sets the actual
  charge.
- A fal generation no longer fails for good when a status or result check
  answers 408, 429 or 499. The task stays pending for the next check, as
  MachGen and WaveSpeed tasks already did; other 4xx answers still fail it.

## [0.5.0] - 2026-11-09

### Added

- Usage costs set the quoted estimate beside the actual for each notebook
  cell, run and job. The cell inspector shows a cell's cost and, while it
  runs, the run's, call by call, with usage-only, free and unavailable calls
  explained. A total is marked partial while a call is unsettled or unpriced.
  Job rows and the book usage popover show the estimate against the actual.
  `get_book_usage` returns these totals and takes `scope.cell_id` or
  `scope.run_id` for one cell or run, and `list_jobs` includes each job's
  usage totals.

- WaveSpeed adds nine models: Seedance 2.0 References and Edit, Wan 2.7 Edit,
  HappyHorse 1.1 References, HappyHorse 1.0 Edit, Gemini Omni 1.1 Flash
  References, Grok Imagine Video 1.5 References, Kling o3 Pro Edit and Runway
  Aleph 2 Edit. Runway Aleph 2 takes a first frame, a last frame and timed
  keyframes. Estimates for the edits and Seedance 2.0 reference videos use the
  connected videos' durations.

- The MachGen Topaz upscale models can upscale any book video, not only
  MachGen's own outputs. The job sends the source through MachGen's upload,
  and sources of 32 MiB or more are refused before any MachGen call.

### Changed

- Video edits, lip sync, upscale and motion control no longer default to a
  9:16 aspect. Those models leave aspect unset, so a provider that follows an
  omitted aspect keeps the source framing. An explicit setting or a remembered
  notebook aspect still wins. Text, image and reference generation, and the
  explicit reframe models, still default to 9:16.

### Fixed

- fal's H3 Max edit and extend models no longer fail with a 422 when the
  source video is over 50 MiB. A larger source is re-encoded to H.264 under
  the cap, keeping its resolution, frame rate and audio, and a clip too long
  to fit at usable quality stops before upload with a message to trim it.
- A fal request that fal rejects when its result is read is recorded as
  failed, so its estimate no longer counts as spend.
- On Node 22, provider requests no longer fail at random with "Cannot
  construct a Request with a Request object that has already been used" when
  garbage collection runs during the usage price lookup.

## [0.4.3] - 2026-11-07

### Added

- Generation inputs can be selected, reordered and edited as named slots in
  the notebook inspector and chat review, with per-input controls, thumbnail
  previews and prompts that keep their references when cells move.

- `cancel_job` can cancel a leftover provider task by artifact and expected task
  ID after local jobs finish, preserving media and recording the cancellation.

- Portable `export-book` and `import-book` CLI commands preserve book identity,
  media versions, notebooks, revision history, and posting records in a
  checksummed archive. They coordinate with a running local app; imports reject
  existing names/IDs and start automatic schedules paused. Upload archives
  manually and explicitly resume schedules with `set_book_automation`.

- WaveSpeed is a new video provider with 23 models: Seedance 2.5 (text,
  image, references and video edit), Seedance 2.0, MiniMax H3 (text, image,
  references and edit), Wan 3.0 (text, image, references and video edit),
  HappyHorse 1.1, Gemini Omni 1.1 Flash (text, image and video edit),
  FLUX 3, HeyGen Video and Grok Imagine Video 1.5. Each WaveSpeed endpoint is
  its own catalog model, named with a "(WaveSpeed)" suffix, and estimates use
  the @apicity/cost WaveSpeed list prices. A submission becomes a
  `wavespeed_media` provider task that the reconcile poll completes from the
  prediction's output URL. `WAVESPEED_API_KEY` is a managed key; without it,
  generation stops before an asset is created and WaveSpeed predictions stay
  unpolled. Usage rows, provider task status and the task panel include
  WaveSpeed.

### Changed

- Every @apicity package moves to 0.27.1. Usage and price forecasts use the
  shared cost APIs, including provider-reported charges, fal billable units
  and cached realtime audio, image and text tokens. Retired fal Sora 2 models
  are removed.
- `videobook-engine` 5.9.1 preserves the existing schema and fixes portable
  book snapshots on Windows.

### Fixed

- Windows book exports no longer fail with "output file is in use by another
  connection" when creating the catalog snapshot.
- The installed web UI loads when its installation path contains a hidden
  directory.
- Recovery safely rebuilds video derivatives, and generation input dialogs
  preserve the selected notebook cells and the inspector's model choice.

## [0.4.2] - 2026-11-01

### Added

- `/split @a1 at scenes` reviews detected camera cuts one at a time, with
  large before and after frames, three frames on each side to move the cut
  to, the usual nudges and a ±1s loop across the cut. K keeps a cut, X
  removes it, J goes back and ← → nudge by a frame. A filmstrip marks each
  cut's status and adds a cut on double-click, removed cuts can be restored,
  and weaker candidates can be added for review in one step.
- `split_video_at_scenes` splits a notebook video into one clip per scene: it
  detects camera cuts, reusing a cached `detect_scenes` result, then adds a
  split cell and one output cell per scene below the source and runs it.
  Pass `cut_points_seconds` to split at reviewed times instead.
- The Kie Grok Imagine Video 1.5 preview takes a loop image (`@loop`) and up
  to four timed keyframes (`@keyframe1`-`@keyframe4`) in notebooks and
  `generate_video`. Keyframes without a time are spaced evenly over the clip.
- MachGen MiniMax H3 Omni turns image or video references into a 768p clip
  of 1-15 seconds at 0.02 USD/s. `generate_video` accepts it, and like
  MachGen's own app the model picker leaves it out.

### Changed

- `detect_scenes` places camera cuts on the exact frame and scores each
  frame's change against the surrounding half second, so hard cuts in dark
  or low-contrast footage are no longer dropped. The default minimum score
  is 5, and `detail: "full"` also returns every cut, motion settle and a
  filmstrip.
- The split editor has a cut editor under the source player: large before
  and after frames, an eight-frame strip where clicking a frame moves the
  cut, and nudges of one frame, 0.1s and 1s. Its Across cut loop replaces
  Surroundings.
- `@apicity` 0.24.0. MachGen image edits take up to 16 images for GPT Image
  2, GPT Image 2.5 Sunburst and Flare, and up to 14 for Nano Banana 2 and
  2.1, up from nine.
- MachGen MiniMax H3 Turbo estimates follow MachGen's current 0.015 USD/s
  promotion.

### Fixed

- A Grok Imagine Image 2.0 generation with connected images that fails before
  reaching xAI is captured under `v1.images.edits`, the endpoint it would have
  posted to, instead of `v1.images.generations`, so `apicity har report`
  resolves it.
- Notebook generation previews for Grok Imagine Image 2.0 name the xAI image
  endpoint, `v1.images.edits` with connected images and
  `v1.images.generations` without, instead of the video endpoint.

## [0.4.1] - 2026-11-01

### Added

- Optional Omkar trending source for research schedules when `OMKAR_API_KEY`
  is set, through `@apicity/omkar`. Status reports omkar as not configured
  when the key is unset. The default Thailand schedule makes one trending
  request per sample and does not retry it.
- `@apicity` 0.23.1, including the ElevenLabs `scribe_v2` cost rate.
  MachGen Seedance 2.5 and 2.0 estimates follow that package's public pricebook.
- Every fal video endpoint in Apicity, including Seedance 2.0 and 2.5, the
  MiniMax H3 family (LoRA, extend, 3D, lip-sync, camera controls and Max
  Turbo reference-to-video), Kling O3 Pro and v3, FLUX 3, Wan 2.7, Gemini
  Omni Flash, LTX 2.5, Luma Ray 3.2, HappyHorse 1.0 and 1.1, Grok Imagine 1.5,
  Cosmos 3, Sora 2, Veo 3.1 and HeyGen video tools. fal also adds Krea 3
  text-to-image and edit, Mirelo video-to-audio and Topaz image upscale.
- xAI Grok Imagine Video 1.5 with first and last frames, Grok Imagine Video
  1.5 Lite, and Grok Imagine Image 2.0 for text-to-image and edits.
- MachGen GPT Image 2, GPT Image 2.5 Sunburst and Flare, and Nano Banana 2
  and 2.1 for text-to-image and edits of up to nine images; MiniMax H3
  Sharpen for MachGen's own H3 videos; and reference-video edit and extend
  on MachGen models that support them.
- Extend video and Upscale video actions on video cells. Upscale uses
  MachGen's 2K regeneration for MachGen MiniMax H3 videos and otherwise the
  first configured Topaz upscaler from MachGen, fal or Kie.
- Live splice preview in the splice inspector and the chat splice review: it
  plays the first clip into the second at the predicted cut, and a
  frame-match curve sets the overlap, with a best-match jump and a quality
  grade. The read-only `preview_splice` tool scores the cuts, and
  `splice_video` cuts where the preview shows.
- `change_video_speed` retimes a section with `start_seconds` and
  `end_seconds`, and its review sheet edits the range, speed and target
  duration in place with a live preview.

### Changed

- ElevenLabs `scribe_v2` speech-to-text usage is estimated from the audio
  duration already known to the transcribe, caption, sync, render, archive,
  extend and sound-removal paths. A request with no duration stays unpriced.
- `trending_research` without arguments creates or addresses the Thailand
  schedule (Asia/Bangkok, 00:30 cutoff, four samples, top 10), and
  `/trending schedule` and `/trending TH` both work.
- The Post inspector shows a live preview, Clip, Caption, Deliver, Link and
  Results progress, a platform picker, a caption counter against the
  platform limit and a delivery rail for iPhone, download and X.
- Save to iPhone has a compact caption and an animated iCloud upload status,
  including progress a sync relay reports for servers without iCloud Drive.
- The composer's voice control is a phone button that rings while a call
  connects and hangs up on hover; the text button ends a call and returns to
  typing, and send sits beside the chat model menu.
- Notebook cells show tags naming where their wires go instead of bare port
  dots.
- Workspace action settings use a compact grid, so actions such as
  `/trending` fit on screen.
- Watermark handles default to 28px of vertical padding.

### Fixed

- Research runs that earlier builds left with stale download errors settle
  on the next scheduler tick, and their rank cells, summary and status
  recover without new downloads.
- Research archive spend stays visible after retention deletes a day book:
  archive usage moves to the control book, and `trending_research` status
  reports it.

### Security

- `@modelcontextprotocol/node` 2.1.2 and `@hono/node-server` 2.1.5.
  `hono` is no longer a direct server dependency; the SDK depends on it.

## [0.4.0] - 2026-10-28

### Added

- Daily TikTok research books with ranked clips, source provenance and a
  download-status summary. Country schedules support local cutoffs, sampling,
  ranking, retention and optional downstream processing; repeated cuts reuse
  the same day book, and schedules resume and catch up after a restart.
- `trending_research` MCP tool with `schedule`, `unschedule`, `list`, `run`
  and `status` operations, also available through `videobook run` for cron.
- Endless public trends and TikTok Creative Center adapters through Apicity,
  with normalized sightings, source health and promoted-content filtering.

### Fixed

- TikTok downloads use yt-dlp browser impersonation when available, optional
  cookies, pacing and retries, with failure reasons retained on research cells.
- Research rank cells and the summary now follow download completion and retry
  recovery, clearing stale errors after a successful download.

## [0.3.3] - 2026-10-27

### Added

- A TikTok-style subtitle editor in the chat composer. `/subs @video`, a
  video cell's Subtitles menu item, or asking chat or voice for subtitles
  opens it beside the chat: a portrait preview that plays with audio and
  highlights each spoken word, an editable transcript (text, timing, hidden
  and inserted words, phrase splits and joins), style, size, colours,
  outline, padding, language, frame and timing controls, and a draggable,
  keyboard-adjustable vertical position for all phrases or one. Drafts save
  as you edit, export to SRT or WebVTT, and Render creates a new subtitled
  video cell below the source (later renders become versions of it). The
  source video is never changed.
- `caption_video` MCP tool with `op: get | prepare | update | render`. `get`
  reads the draft and preparation status without starting work (`detail:
  full` adds the document, face/text regions and loudness envelope);
  `prepare` starts word-timed transcription, vocal timing, optional face
  and on-screen-text placement and translation; `update` saves edits, a
  replacement document or a resolution (`reseed`, `realign`,
  `keep_timings`, `discard`) against `expected_revision`; `render` takes the
  reviewed revision, `source_hash` and a stable `request_id` and returns the
  same job on retries. Only `prepare` spends money.
- Caption analysis is keyed by content: repeated or concurrent requests reuse
  one job, cached results return without provider calls, a failed refresh
  keeps the last result, and results for a video that changed mid-analysis
  are discarded. Subtitles render with bundled Montserrat and Anton (OFL),
  load Noto Sans subsets on demand for other scripts, and handle
  right-to-left text.
- `force` on `transcribe`, `translate_subtitles`, `describe_image`,
  `detect_scenes`, `suggest_cuts`, `suggest_sfx` and `analyze_jokes`
  (`analyze_video` already had it) to run again on unchanged inputs.
- Subtitles can replace the video in place instead of adding a new cell:
  choose Replace video beside the subtitle editor's export buttons. Render
  burns the subtitles into the source video, keeps its earlier version in
  history, and the cell shows RENDERING until the job finishes.
  `caption_video` render takes `output: "new" | "replace"`.
- `/post` posts a clip in one step. One sheet offers three destinations:
  iCloud · iPhone, Download (the clip and caption.txt download to this
  computer for a manual upload) and X, now or scheduled. Applying a
  destination creates the Post when needed, freezes the clip and caption and
  delivers them. A clip's menu offers Post…, and a Post's menu offers Save to
  iPhone and Download.
- `/files` serves an artifact file as an attachment when given
  `?download=<name>`, so download links save instead of playing inline.
- Eighteen more MachGen video models. The picker offers LTX 2.3 Pro,
  MiniMax H3 Turbo, Seedance 2.0 Fast and Mini, Kling 3.0 and Kling 3.0 Omni,
  Veo 3.1 and Veo 3.1 Fast, Pixverse V6 and C1, HappyHorse 1.0 and Grok
  Imagine Video. Wan 2.2 A14B, Vidu Q3, Q3 Turbo, Q3 Pro, Q3 Pro Fast and Q4
  Preview, which MachGen hides from its own picker or keeps private, are
  available through `generate_video` and `list_generation_models` with
  `include_hidden`. Each model offers the resolutions, lengths, aspect ratios,
  frames and references MachGen accepts for it and is priced from MachGen's
  pricebook. Kling 3.0 Omni takes multi-shot settings: `shot_type:
  "intelligence"` lets the model plan the shots, and `"customize"` takes
  `multi_prompt` and `shot_durations`, which must add up to the duration.
- MiniMax H3 2K regeneration (`machgen:MiniMax-H3/upscale`, available through
  `generate_video`): connect a 5-15 second MiniMax H3 768p video that MachGen
  generated, and MachGen renders it again at 1440p from its original prompt
  and inputs. It costs $0.05 per second of the source, counted twice (in and
  out). Other videos and URLs are refused before anything is spent.

### Changed

- The posting MCP tools shrink from 15 to 8. `post` takes `to: icloud |
  download | x | draft` with `asset_id` for a new Post or `post_cell_id` for
  an existing one. `list_posts` reads one Post with `post_cell_id` and the
  X posts waiting to publish with `status: "scheduled"`. `update_post` takes
  `url` and `posted_at` after posting by hand, and `cancel_schedule` to turn a
  scheduled X post back into a draft. `record_post_metrics` without values
  fetches the current X metrics. `service_status` with `service: "icloud"`,
  `book_id` and `post_cell_id` reports whether a Post's files finished
  uploading.
- The Actions form and a timeline track's add-clip chooser are no longer
  modal dialogs. Both open as a review docked in the chat composer, like a
  generation review: Apply, or Enter on `/apply`, runs the action or adds the
  chosen clip, and Cancel, Escape or `/cancel` closes it. An action that needs
  confirmation shows its review and estimated cost on the first Apply and runs
  on the second; read results and their links stay on the review. In the
  fullscreen timeline editor the add-clip review docks at the editor's foot.
- Image models default to 2K again (or the highest resolution they offer
  below 2K) instead of their highest resolution; 4K stays available to
  choose. New goals plan their scene at 2K. Video models keep their highest
  resolution, and a resolution a notebook remembers from a cell still applies.
- Render in the subtitle editor no longer waits for the video: it queues the
  render, closes the editor and frees the chat, and the chat turn follows the
  job until the subtitled copy or the updated video is ready. `caption_video`
  render also returns the job's `job_id`, `status` and `output_artifact_id`
  at the top level.
- Every analysis tool is keyed by the content it reads: speech-to-text by the
  transcribed audio and settings, translations by the timed transcript and
  language, video analysis by the video and the transcript it used, image
  descriptions by the image, scene scans by the video, cut and sound-effect
  suggestions by the video, transcripts, analysis and instructions, and joke
  analysis by the timed transcript. A repeat returns `status: "cached"`
  (suggestions and jokes include the earlier entries) without a provider
  call, a job or a write; otherwise the tools return `queued` or `running`
  with a numeric `job_id`, and concurrent or forced requests join one job.
  These tools no longer return `enqueued`, `already_analyzed` or string job
  ids.
  Automatic transcription and analysis jobs skip the provider when their
  result is current, results whose inputs changed mid-run are discarded, a
  failed refresh keeps the previous result, and undoing an edit serves the
  earlier analyses again. Sidecars written by earlier versions are adopted
  once instead of being paid for again.
- `describe_image` returns the script asset it already wrote for an unchanged
  image instead of creating a new one per call.
- Captions, keyword titles and watermark placement share one cache of face
  and on-screen-text regions per video frame, so each pass only sends frames
  no earlier pass analysed.
- A render with a translated `subtitle_language` fails with the reason when
  the translation cannot be made, instead of burning the original language.
- Editing a video's picture or sound still deletes its video analysis and,
  for sound or timing edits, its transcripts; scene scans, suggestions and
  joke analyses are kept and simply stop matching the edited media.
- Thai, Lao, Khmer, Burmese, Chinese and Japanese speech is read as words.
  ElevenLabs returns these scripts a letter at a time; transcripts,
  subtitles, SRT exports, the transcript card, search text, suggestions and
  translations now join the letters into dictionary words without spaces
  between them, Thai syllables the dictionary does not know (loanwords,
  colloquial particles such as เหรอ) stay whole, and a space in Thai ends a
  subtitle phrase so it is never silently dropped. Subtitle phrases are
  measured by visible width (Thai vowel and tone marks take none, CJK
  characters take two), the seven-word cap applies only to spaced scripts,
  and a clause too long for one phrase splits into the fewest even phrases.
  The Impact and Highlight render styles no longer put gaps between Thai or
  CJK words. Short Thai and Chinese speech now counts as dialog, so it is
  transcribed automatically. Translations from Thai send whole clauses to the
  translator, and translations into these languages time real words instead
  of character pairs. Subtitle drafts saved by earlier versions are
  discarded, and caption vocal timing is measured again once per video.

- `/alive` opens the new subtitle editor. Saved Alive caption settings seed
  the editor's style, a matching saved Alive analysis is reused instead of
  being paid for again, stored renders that still use the `alive` subtitle
  style render through the new captions, and queued `analyze_alive_captions`
  jobs run caption preparation.
- `render_video` and `render_project` no longer accept `highlight_style:
  "alive"`; use `caption_video` for word-timed subtitles.

### Removed

- The `create_post`, `get_post`, `link_post`, `save_post_to_icloud`,
  `post_icloud_sync_status`, `refresh_post_metrics` and
  `upload_post_to_dropbox` MCP tools and their slash commands. Use `post`,
  `list_posts`, `update_post`, `record_post_metrics` and `service_status`
  instead.
- Dropbox delivery: the Dropbox connection in `connect_service` and
  `service_status`, its Settings card and the `@apicity/dropbox` dependency.
  It needed a Dropbox app that was never configured, and Download covers
  manual uploads.
- The `alive_captions` and `set_alive_captions` MCP tools and the
  full-screen Alive captions studio. Use `caption_video` and the subtitle
  editor instead.

### Fixed

- A Post delivery that finishes no longer overwrites a destination chosen
  while it was still running.
- Settings shows the selected project's storage after switching projects
  while a storage check for the previous project is still loading.
- Trimming an audio asset updates its recorded duration, streams and
  waveform, so the library and timeline report the trimmed length.

### Security

- Dependencies move to patched releases: the MCP TypeScript SDK server and
  client 2.4.0, vite 7.3.7, vitest 4.1.12, zod 4.6.7 (also inside Remotion
  Studio, through an override), undici 7.30.1, hono 4.13.14, body-parser
  2.4.0, follow-redirects 1.16.2, fast-uri 3.1.9 and ip-address 10.7.5.
  `npm audit` reports no vulnerabilities.

## [0.3.2] - 2026-10-26

### Added

- The KIE Grok Imagine Video 1.5 preview's 1080p tier, priced at $0.04 per
  second. At 1080p it takes exactly one image (`image_urls`); 480p and 720p
  still take more.

### Changed

- Every `@apicity` package is at 0.19.0.
- The KIE Grok Imagine Video 1.5 preview defaults to 1080p, its highest
  resolution, as `kie:grok-imagine/image-to-video` already does. A request
  with more than one image needs 480p or 720p and is refused before
  anything is spent.
- The KIE Grok Imagine Video 1.5 preview sends `nsfw_checker: false` by
  default, the default KIE documents and every other KIE video model with
  the setting already sends. 0.3.1 sent `true`; pass `nsfw_checker: true` to
  keep KIE's content filter on.
- KIE Seedance 2.5 keeps generating audio by default. apicity 0.19.0 now
  defaults `generate_audio` to `false`, but Videobook still sends `true`
  unless a request turns audio off.
- MachGen estimates follow the 0.19.0 pricebook. A MiniMax H3 run with a
  first and a last frame is priced at the image-to-video rate ($0.035 per
  second at 480p instead of $0.05), and Wan 3.0 references that include a
  video add the reference video's seconds to the output's.
- KIE OmniHuman 2.0 generations turn KIE's watermark off by default
  (`enable_watermark: false`); pass `enable_watermark: true` to keep it.
  OmniHuman 2.0 videos generated with 0.3.1 carry the watermark. OmniHuman
  1.5 has no watermark option.

### Fixed

- A catalog model the installed apicity packages cannot resolve no longer
  fails the whole model listing, which left every book looking empty on
  load. The listing skips that model and logs a `model-unresolvable`
  warning naming it.
- Queued KIE OmniHuman 1.5 and 2.0 generations pass their driving audio's
  length to the cost estimate, so the KIE paygate estimate is bounded and the
  usage row is priced.
- Queued KIE HappyHorse video edit and Kling 3.0 motion control generations
  pass their source video's length, and Volcengine lip sync passes its audio's
  length, so their paygate estimates and usage rows are priced too.
  `estimate_cost` now prices Volcengine lip sync from the audio, whose length
  the output follows, instead of the source video.
- The usage counter groups each catalog generation under its catalog media.
  34 KIE and fal models, among them OmniHuman, the HeyGen digital twins, the
  Gemini and ElevenLabs speech models and the Bria image models, were counted
  as analysis, and fal Wan 2.7 image edit as video.
- KIE Suno music and sound generations now reach the usage counter as audio,
  priced at KIE's flat rate per generation: $0.06 for music and $0.0125 for
  sounds. Their status polls settle the row: a lyrics-only result stays
  pending, and a failed generation is not counted as spend.
- KIE generations stay pending in the usage counter until their task
  settles. A queuing or generating KIE task, or a Veo task that is still
  generating, was counted as settled spend at its first status poll, and a
  Veo generation that failed while generating (`successFlag` 3) was counted
  as completed spend.
- A Veo generation that fails while generating now fails with KIE's error
  message at the next status poll. It was treated as still processing and
  polled until the pending-task timeout.

## [0.3.1] - 2026-10-25

### Added

- KIE Kling 4.0 reference-to-video and keyframe-to-video, 3 to 30 seconds at
  720p or 1080p. Reference-to-video takes up to ten images and five videos,
  and generates from the prompt alone when none are connected. Keyframe-to-video
  takes a first frame, up to eight middle keyframes and a last frame, as many
  as the duration allows. Prompts name connected media the way Kling 4.0 does:
  `@image_1`, `@video_1`, `@first_frame`, `@keyframe_1` and `@last_frame`.
- KIE PixVerse V6 Max text-to-video and image-to-video, 1 to 15 seconds at
  360p to 1080p, with optional generated audio and a seed. Image-to-video
  follows the image's aspect ratio.
- KIE OmniHuman 2.0, which animates one image to a driving audio track at 720p
  for as long as the audio runs, with an optional prompt of up to 300
  characters. KIE's watermark stays on by default (`enable_watermark`).
- The KIE Grok Imagine Video 1.5 preview, the KIE Grok Imagine endpoint that
  takes first and last frames, a loop image (`loop_url`) and up to four timed
  `keyframes`. It shares the Grok Imagine Video 1.5 image-to-video frontier
  ranking. Kling 4.0, PixVerse V6 Max and OmniHuman 2.0 are on no top-10 board
  and appear in the unranked group.

### Changed

- Upgrade all `@apicity/*` dependencies to 0.18.1, which prices the new KIE
  models. Its endpoint catalog now lists fal `v1.queue.status` and
  `v1.queue.result`, with the other fal SDK methods written as method
  shorthand, so `apicity har report` from `@apicity/cli` 0.18.1 can resolve the
  fal polling captures Videobook writes. The requests sent to fal are
  unchanged.
- Image and video models default to a 12-second duration (or the nearest
  allowed length), a 9:16 aspect ratio and their highest resolution, quality
  and bitrate. Each notebook remembers the last duration, aspect ratio,
  resolution and quality a cell used, and applies them to new cells and model
  switches. Goals saved before this change keep their 2K scene; new goals use
  4K.
- On desktop, Settings shows AI providers in one column and accounts, storage
  and diagnostics in another; on phones the columns stack behind section jump
  buttons. The chat input stays a plain bar on Settings.
- The Library opens from an Assets button in the notebook toolbar instead of
  the header, and Arrange is renamed Clean.
- Library browsing pages assets before building their rows and no longer runs
  ffprobe while listing; proxy checks and duration backfills run as background
  jobs.
- A Post can take its published link without being saved to iPhone or Dropbox
  first.

### Fixed

- HAR captures of KIE's nested Veo and Suno SDK calls are named by their
  apicity catalog dot paths, such as `api.v1.veo.generate` and
  `api.v1.generate.sounds`, instead of their SDK paths, so `apicity har report`
  resolves them. Sub-provider prefixes that are URL segments stay:
  `kie.claude.post.v1.messages` is named `claude.v1.messages`.
- A generation that fails before reaching its provider, such as a request the
  schema refuses, is captured under the provider's catalog endpoint, and fal,
  Alibaba and KIE file uploads are captured as `storage.upload.initiate`,
  `api.v1.uploads` and `api.fileStreamUpload`, so `apicity har report` resolves
  them.
- A notebook generation whose provider fails after accepting the request now
  marks its plan failed with the provider error. `list_notebook_generation_plans`
  and the Jobs screen kept reporting such plans as awaiting output.
- v3 goals saved with a 2K scene load again and keep that resolution when they
  are edited, approved or retried.
- Image subject edits check the provider key before uploading the source image,
  so a missing or placeholder key no longer sends the image to a public file
  host for a request that cannot run.
- Settings loads when the page opens on it, or when it opens before the MCP
  connection is ready.
- The multyculty workflow and video poster recovery tests no longer time out on
  loaded hosts, and the chat-composer browser test no longer reads the runner's
  `.env` or provider keys and matches the ranked model picker.

## [0.3.0] - 2026-10-24

### Added

- Opt-in local provider HAR diagnostics with Settings, MCP and CLI controls, concurrent book attribution and retention limits.
  Captured SDK calls are named by their apicity catalog dot path, such as
  `api.v1.jobs.createTask`, so `apicity har report` attributes them to their
  endpoints.
- The Request payload panel of a queued, generating or failed cell downloads
  the attempt's scrubbed captures as one HAR file, or shows "Capture off" with
  a link to Settings. `inspect_generation_request` reports whether an asset has
  a capture, with its path and outcome; the new `get_generation_har` tool
  returns the HAR for an asset or attempt id.
- `videobook har list` and `videobook har export --out <dir|file.tar.gz>`,
  both with `--since`, `--failures` and `--provider`. Export re-runs the
  `@apicity/har` scrubber on every capture and refuses, naming the file, when
  scrubbing would change it. Otherwise it writes the captures with an index
  and a manifest and prints the `apicity har report` hand-off.

### Changed

- Upgrade all Apicity dependencies to 0.18.0.

## [0.2.5] - 2026-10-24

### Added

- Thirteen fal video endpoints: Kling 4 text, frame, reference and editing;
  HeyGen Video text, image and reference generation; HeyGen Avatar 3/4/5
  stock digital twins, Avatar 4 image animation, and Video Agent v2/v3.
- HeyGen Video text and reference models appear in the ranked pickers.
  Kling 4 appears in the unranked group. Digital twins accept spoken scripts
  with stock avatar and voice defaults; Avatar 4 image animation defaults to Ivy.

### Changed

- Upgrade all Apicity packages to 0.17.1 and refresh generated model documentation.

## [0.2.4] - 2026-10-23

### Added

- Image and video model pickers show frontier rankings from the offline
  `@apicity/cost` snapshot, with rank, Elo and price for the selected operation.
  Other models follow in their existing order; unconfigured providers are
  marked unavailable. Saved selections and default models stay unchanged.

- MachGen as a video provider, with six models: MiniMax H3, Seedance
  2.5, Seedance 2.0, Wan 3.0 and HappyHorse 1.1 for text, frame and
  reference video, and Grok Imagine Video 1.5 for image-to-video. Each
  model offers its own resolutions, durations and aspect ratios, and
  cost estimates come from the `@apicity/cost` MachGen per-second rates.
  Wan 3.0 always sends MachGen's documented adaptive, 30 fps, with-audio
  config. Generations run as provider tasks: Videobook polls MachGen and
  downloads the finished video with the API key.
- `MACHGEN_API_KEY` is a managed key. `videobook config`, 1Password
  resolution and the provider keys panel include it. Without it, MachGen
  generations stop with "MACHGEN_API_KEY environment variable is not set"
  before an asset is created, and pending MachGen tasks wait unpolled.
- Seedance 2.5 Draft Complete (`kie:bytedance/seedance-2-5-draft`)
  renders the 1080p final of a 480p Seedance 2.5 draft from the draft's
  Kie task id. A draft rendered in the same book supplies the billed
  seconds and reference video seconds for the estimate. The Kie Seedance
  2.5 model gains the matching `draft` option.

### Changed

- Upgrade all application `@apicity/*` dependencies to 0.17.0 and add
  `@apicity/machgen`.
- Kie Seedance 2.5 estimates use the 2026-10-22 rates, for example
  $0.79 per second at 1080p without a reference video, up from $0.57.

## [0.2.3] - 2026-10-21

### Added

- Fal FLUX 3 Max text-to-video, image-to-video, and keyframes-to-video,
  with generated audio and resolution-tiered per-second cost estimates.
- Bria Fibo 2 text-to-image with structured VGL prompts, and Fibo 2 Edit
  for one to four reference images, including the image editor.
- H3 Max Reframe Video, which outpaints a source video to a target aspect
  ratio at 480p, 768p, or 1080p while keeping its audio and timing.
  Priced from fal's historical average because the request does not fix
  the billed duration.

### Changed

- Upgrade all application `@apicity/*` dependencies to 0.16.3.
- Windows x64 is supported. The release check runs the pack-and-install
  smoke on Windows and blocks the release when it fails. Stopping
  `videobook serve` from another process still ends it without a clean
  shutdown, because Windows has no SIGTERM, and the next start replaces
  the lock file.
- Dynamic fal requests are priced from fal's historical average when
  `FAL_ADMIN_API_KEY` is set. Without the key, and for the two Seedance
  formula gaps, the estimate stays at the local $0.

## [0.2.2] - 2026-10-21

### Added

- KIE FLUX 3 Klein text-to-image and image editing, with 1K defaults,
  up to ten edit references, and resolution-aware per-image cost estimates.
- FLUX 3 Klein Edit in the image editor for whole-image and region edits.

### Changed

- Upgrade all application `@apicity/*` dependencies to 0.16.2.

### Fixed

- Accept npm 12 workspace pack results in the installed-package smoke gate.

## [0.2.1] - 2026-10-20

### Changed

- Upgrade to videobook-engine 5.7.1 with official DoltLite 0.51.1 for
  concurrency, reopened-catalog allocation, schema-conflict recovery, and
  ignored AUTOINCREMENT sequence fixes. Existing 0.50.9 books retain their
  format and engine schema.

## [0.2.0] - 2026-10-19

### Added

- `videobook config` lists where every provider key comes from, with secret
  values masked; `config get`, `config set` and `config unset` edit the
  data-home `.env` atomically.
- 1Password support: `op://` references in the environment or `.env` resolve
  through the 1Password CLI when a server starts, and
  `videobook setup 1password --op-vault <vault>` reads every key from a vault
  whose items are named after the keys. `videobook doctor` reports the setup
  and which keys 1Password supplied.
- `VIDEOBOOK_YTDLP_PATH` selects the yt-dlp binary.
- `list_jobs` accepts `job_keys`, the `job_id` strings other tools return.

### Changed

- ffprobe now comes from `@ffprobe-installer/ffprobe`, which installs one
  native build for the current platform instead of `ffprobe-static`'s builds
  for every platform. Apple Silicon and Linux arm64 get a bundled ffprobe, and
  the install is about 300 MB smaller. When npm skips the package's chmod
  script, videobook marks the binary executable itself.
- The npm page no longer links to the private source repository, which
  anonymous visitors cannot open; its homepage is the npm package page.
- The README states that Windows is not supported yet, and why, instead of
  calling it untested.

### Fixed

- Downloading videos from URLs works when npm blocked the yt-dlp download:
  videobook falls back to `yt-dlp` on `PATH`, passes yt-dlp the resolved
  ffmpeg so format merges work, and fails with install instructions when no
  yt-dlp exists. `videobook doctor` shows which yt-dlp is used.
- `videobook run` waits for queued jobs on an already running server too,
  instead of returning while the job runs, and reports how the job ended.

## [0.1.0] - 2026-10-19

### Added

- `videobook` command-line interface: `serve` runs the MCP server with the
  bundled web UI (or `--headless` for MCP and API only), `mcp` serves MCP over
  stdio for agent hosts, `run` and `tools` call MCP tools from the shell,
  `gc-books` reclaims catalog storage, and `doctor` checks the local
  environment.
- Installed data defaults to `~/.videobook`, overridable with `VIDEOBOOK_HOME`.
