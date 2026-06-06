import type { AssetManifestFile, VideocityFs } from "vc-engine";
import { extname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { StoryboardVideoPlanSidecar } from "./plan-types.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

export const DEFAULT_STORYBOARD_PROMPT = `Create a 16:9 image.

[PROJECT CARD]
Create a compact designed masthead, not a table.
TITLE: BANANA BREAD KITCHEN DANCE
META LINE: bright kitchen / playful recipe montage / energetic satisfying food-prep rhythm
PRIORITY: readable banana bread process, tasteful flirtatious opening, mostly back-to-camera dance prep, clean top-down cooking inserts
MICRO BRIEF: C1 turns banana bread prep into a compact kitchen dance, starting with a camera kiss and ending on a warm loaf reveal.

[CONTINUITY HEADER]
SEQUENCE ID: BANANA-BREAD-KITCHEN-DANCE-16P
REFERENCE PRIORITY: Provided image controls C1 face, body, wardrobe, proportions, silhouette, messy blonde hair, yellow knotted top, loose striped pants, and playful attitude; this storyboard controls staging, motion, kitchen geography, cooking continuity, camera order, and rhythm.

[SCENE PACKET]
PREMISE: C1 makes banana bread in a sunlit home kitchen while lightly dancing through each preparation step.
LOCATION: Daylit kitchen with large window screen left, teal cabinets rear/right, stone counter island foreground, sink left, mixing bowl and ingredients center, loaf pan near oven screen right, cooling rack returns to counter for the final reveal.
START -> END: C1 steps close to camera and blows a kiss -> she mostly turns back to the camera, dances through banana bread prep, bakes the loaf, and presents a steaming slice on the counter.
ACTION CHAIN: camera approach -> kiss toss -> turn to counter -> single banana peel -> top-down mash -> egg crack -> flour rain -> batter fold -> hip-step bowl turn -> loaf pan pour -> banana slice pattern -> oven slide without mitts -> timer beat -> oven pull with mitts -> loaf set-down -> slice pull-apart.
PROP / EFFECT STATE: Bananas, one peeled banana and one peel in P04, mixing bowl, fork, eggs, flour, sugar, whisk, spatula, loaf pan, oven mitts used only when removing the hot loaf, cooling rack, knife, bread slice, crumbs, steam; no messy chaos, no unsafe heat handling, no explicit sexual framing.
MUST READ: The sensuality is playful and tasteful, carried by rhythm, back-facing dance posture, shoulder glances, food texture, and satisfying preparation details rather than nudity or explicit posing.

[CHARACTER SANITIZATION]
C1: young adult woman, messy curly blonde hair, compact athletic silhouette, yellow knotted crop top, loose striped pants, casual kitchen posture, barefoot-or-soft-step dance movement, expressive hands, light flirtatious camera awareness.
Remove contradictory traits, invisible psychology, excessive costume detail, and backstory that cannot appear in a panel.

[IDENTITY CONSISTENCY]
Provided character reference controls C1 face, body, wardrobe, proportions, hair, and silhouette; storyboard controls staging only. Keep C1's messy blonde hair, yellow knotted top, loose striped pants, bare waistline, relaxed smile, and single-performer identity consistent. Do not add cloth tied at waist. Do not redesign, age-shift, beautify, duplicate, merge, or add another character.

[STORYBOARD PURITY]
Panel images are visual-only low-detail monochrome light-gray rough sketches. Put panel numbers, beat names, and lens tags in the header strip outside each panel image. No color, labels, arrows, captions, subtitles, logos, watermarks, timing marks, diagrams, UI, ghost poses, duplicate bodies, or technical overlays inside panels.

[MASTER SHOT RULE]
P02 shows full playable geography: window screen left, island counter foreground, sink left, C1 at center counter with back mostly to camera, teal cabinets rear/right, oven screen right, loaf-pan path from counter to oven and back.

[EMOTIONAL ARC]
Playful invitation -> focused groove -> tactile cooking satisfaction -> quick heat anticipation -> proud reveal, shown through camera distance, over-shoulder glances, shoulder rolls, hand precision, hip-step rhythm, careful oven handling, steam pause, and final slice pull.

[STYLE LOCKS]
STYLE LOCK: clean monochrome rough-sketch storyboard panels on off-white paper, light-gray gesture lines, simplified kitchen shapes, restrained yellow and teal accent only outside panel art, crisp food-prep hierarchy, no rendered panel lighting.
EFFECT LOCK: inside panels, flour dust, steam, crumbs, batter ribbons, and banana slices are simple monochrome shapes only; final video effect is warm daylight bloom, soft steam, glossy batter folds, satisfying slice texture, and clean tactile foley.
ENVIRONMENT LOCK: large window screen left, stone counter island foreground, teal cabinets rear/right, sink left, oven screen right, ingredient cluster center, cooling rack returns to counter; preserve the same kitchen layout across wide and over-shoulder views.

[SPATIAL CONTINUITY LOCK]
P02, P03, P08, P09, P10, P12, P13, P14, P15, and P16 share the same kitchen layout. C1 stays around the island center, mostly back or three-quarter back to camera after P03, except P08 batter fold is a front-facing view at the same counter. C1 moves ingredients from counter center to loaf pan, carries the pan to oven screen right without oven mitts in P12, then uses oven mitts to remove the hot loaf in P14 and returns it to the counter. Window remains screen left, cabinets rear/right, sink left, oven screen right. Allowed changes are camera distance, camera height, C1 pose, gaze, ingredient state, steam, crumb state, and loaf position.

[DIRECTOR STRIP]
Bottom animatic track board aligned to panel columns. Tracks: BEAT LINE, CAMERA PATH, ACTION PATH, RHYTHM TRACK, ESCALATION MAP, STATE TRACK, STYLE TRACK. Use shot chips, thin lines, rhythm blocks, small intensity bars, one-to-three-word labels. No seconds or timestamps.
RHYTHM TRACK format: RHY P##: [hold|slow reveal|build|burst|impact|pause|recover|final hit] / [short block|medium block|long block] / [clean beat|match beat|smash beat|held beat|whip beat].
ESCALATION MAP format: ESC P##: [L1 calm|L2 tension|L3 rise|L4 surge|L5 peak] / [flat|rise|spike|drop|release|unresolved].
PANEL HEADERS: P01 / 35mm close / Kiss approach -> P02 / 24mm wide / Kitchen master -> P03 / 50mm back / Counter groove -> P04 / overhead 35mm / Single banana peel -> P05 / overhead 35mm / Mash swirl -> P06 / macro insert / Egg crack -> P07 / macro insert / Flour rain -> P08 / 35mm front / Batter fold -> P09 / 50mm back / Hip-step mix -> P10 / overhead 35mm / Pan pour -> P11 / macro insert / Banana pattern -> P12 / 35mm track / Oven slide -> P13 / 85mm tight / Timer glance -> P14 / 35mm back / Oven pull -> P15 / 50mm counter / Loaf reveal -> P16 / macro insert / Slice pull
CAMERA + LENS PLAN: P01 handheld close push -> P02 wide geography hold -> P03 soft push behind -> P04 overhead locked -> P05 overhead locked -> P06 macro cut -> P07 macro cut -> P08 front hold -> P09 back-view sway -> P10 overhead locked -> P11 macro cut -> P12 rightward track -> P13 tight reaction -> P14 back-view pull -> P15 counter-level hold -> P16 macro final hold
ACTION PATH: P01 C1 steps in, blows kiss -> P02 turns to island, setup visible -> P03 shoulders roll, hands reach one banana -> P04 one banana peel lands beside bowl -> P05 single banana mashes into texture -> P06 egg splits into bowl -> P07 flour falls cleanly -> P08 C1 faces camera while spatula folds batter -> P09 C1 dances while rotating bowl -> P10 batter ribbons into pan -> P11 banana slices line top -> P12 pan slides into oven, no mitts -> P13 C1 glances back, hand on timer -> P14 oven mitts pull loaf out -> P15 loaf lands on rack, steam rises -> P16 slice opens, crumb stretches
RHYTHM TRACK: P01 RHY P01: burst / short block / clean beat -> P02 RHY P02: slow reveal / medium block / held beat -> P03 RHY P03: build / medium block / match beat -> P04 RHY P04: burst / short block / clean beat -> P05 RHY P05: build / medium block / match beat -> P06 RHY P06: burst / short block / smash beat -> P07 RHY P07: pause / medium block / held beat -> P08 RHY P08: build / medium block / clean beat -> P09 RHY P09: burst / short block / match beat -> P10 RHY P10: impact / medium block / held beat -> P11 RHY P11: pause / short block / clean beat -> P12 RHY P12: impact / medium block / clean beat -> P13 RHY P13: hold / short block / held beat -> P14 RHY P14: build / medium block / clean beat -> P15 RHY P15: final hit / long block / held beat -> P16 RHY P16: final hit / medium block / clean beat
ESCALATION MAP: P01 ESC P01: L3 rise / spike -> P02 ESC P02: L1 calm / flat -> P03 ESC P03: L2 tension / rise -> P04 ESC P04: L3 rise / spike -> P05 ESC P05: L3 rise / rise -> P06 ESC P06: L4 surge / spike -> P07 ESC P07: L3 rise / drop -> P08 ESC P08: L3 rise / rise -> P09 ESC P09: L4 surge / spike -> P10 ESC P10: L4 surge / spike -> P11 ESC P11: L3 rise / drop -> P12 ESC P12: L4 surge / rise -> P13 ESC P13: L2 tension / flat -> P14 ESC P14: L4 surge / rise -> P15 ESC P15: L5 peak / release -> P16 ESC P16: L4 surge / release
STATE TRACK: P01 face close -> P02 full kitchen, ingredients raw -> P03 back to camera, bare waistline -> P04 one banana peeled -> P05 mashed bowl -> P06 egg added -> P07 dry ingredients -> P08 front batter fold -> P09 back-view dance, bare waistline -> P10 pan filled -> P11 slices on top -> P12 pan in oven, no mitts -> P13 waiting beat -> P14 mitts on, loaf out -> P15 loaf on rack -> P16 slice separated
STYLE TRACK: P01 smile chip -> P02 kitchen map -> P03 back sway -> P04 single peel -> P05 mash texture -> P06 egg shine -> P07 flour cloud -> P08 batter ribbon -> P09 pants sway -> P10 glossy pour -> P11 slice pattern -> P12 oven slide -> P13 playful glance -> P14 mitt silhouette -> P15 steam reveal -> P16 crumb macro

[SEQUENCE]
Grid: 16 panels in a compact 4x4 cinematic storyboard sheet; panel artwork stays monochrome rough sketch while the director strip shapes a playful cooking-dance montage with camera-kiss hook, mostly back-facing kitchen choreography, top-down banana bread prep inserts, oven payoff, and satisfying slice finale.`;

export const DEFAULT_VIDEO_PROMPT = `Use [Image 1] as the authoritative director-approved storyboard blueprint for the sequence. Treat every storyboard panel as a consecutive shot within a single cinematic sequence. Follow panel order exactly and do not invent alternative coverage. The storyboard is the primary source of truth for visual storytelling. Recreate the filmed sequence implied by the panels rather than the physical storyboard artwork.
Use [Image 2] as the authoritative C1 character reference.

EMOTIONAL GUIDANCE: Valence: playful, warm, teasing, proud. Arousal: quick hook to steady groove, tactile prep surges, brief pause, satisfying release through body rhythm, over-shoulder glances, hand precision, steam, crumbs, and food texture.

PANEL BEATS:
P01: Handheld close as C1 steps toward camera, smiles, and blows a kiss; soft breath and fabric rustle.
P02: Wide kitchen master shows window left, island, sink, cabinets, oven right, and ingredients as C1 turns to counter.
P03: Behind C1, she rolls her shoulders lightly and reaches for one banana, mostly back to camera; bare waistline.
P04: Top-down, one banana peel curls beside the bowl while her hands work cleanly.
P05: Top-down, fork mashes one banana into a smooth textured pulp with wet satisfying foley.
P06: Macro egg crack drops into the bowl, shell halves separating cleanly.
P07: Macro flour and sugar fall in a cloud, then settle on the banana mixture.
P08: Front view, C1 folds batter in slow glossy ribbons as she steps in rhythm.
P09: Back view, C1 rotates the bowl with a playful hip step, striped pants swaying.
P10: Overhead, batter pours into the loaf pan in a thick continuous ribbon.
P11: Macro, banana slices are placed in a neat pattern across the batter top.
P12: Tracking right, C1 slides the pan into the oven without mitts.
P13: Tight reaction, she glances over her shoulder at camera, hand near the timer, holding still for a beat.
P14: Back view, oven opens and C1, now wearing oven mitts, lifts out the risen loaf; warm steam rolls up.
P15: Counter-level, loaf lands on the cooling rack, golden top visible, steam and crumbs catching daylight.
P16: Macro final, knife opens a slice and soft crumb pulls apart, ending on satisfying texture.`;

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

async function assertImageAsset(fs: VideocityFs, projectSlug: string, assetId: string, label: string): Promise<void> {
  if (!assetId.startsWith("img-")) throw new Error(`${label} must be an img-* asset, got: ${assetId}`);
  const manifest = await fs.getManifest(assetId, projectSlug, { includeDotfiles: false });
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findImageFile(manifest.value.files);
  if (!file) throw new Error(`No image file found in asset ${assetId}`);
}

function renderMarkdown(sidecar: StoryboardVideoPlanSidecar): string {
  return [
    "# Plan: image -> storyboard -> video",
    "",
    `**Source image:** @${sidecar.source_image_asset_id}`,
    `**Storyboard:** ${sidecar.storyboard_asset_id ? `@${sidecar.storyboard_asset_id}` : "not generated"}`,
    `**Video:** ${sidecar.video_asset_id ? `@${sidecar.video_asset_id}` : "not generated"}`,
    `**Storyboard model:** ${sidecar.storyboard_model}`,
    `**Video model:** ${sidecar.video_model}`,
    `**Duration:** ${sidecar.duration_s}s`,
    `**Aspect:** ${sidecar.aspect_ratio}`,
    "",
    "## Storyboard Prompt",
    "",
    sidecar.storyboard_prompt,
    "",
    "## Video Prompt",
    "",
    sidecar.video_prompt,
    "",
  ].join("\n");
}

export async function writeStoryboardVideoPlan(
  fs: VideocityFs,
  projectSlug: string,
  sidecar: StoryboardVideoPlanSidecar,
): Promise<void> {
  const projectResult = await fs.getProject(projectSlug);
  if (!projectResult.ok) throw new Error(projectResult.error.message);
  await mkdir(join(projectResult.value.path, "plan"), { recursive: true });

  const writeMd = await fs.writeFile("plan", "index.md", renderMarkdown(sidecar), projectSlug);
  if (!writeMd.ok) throw new Error(`Failed to write index.md: ${writeMd.error.message}`);

  const writeJson = await fs.writeFile("plan", ".plan.json", JSON.stringify(sidecar, null, 2), projectSlug);
  if (!writeJson.ok) throw new Error(`Failed to write .plan.json: ${writeJson.error.message}`);
}

export async function readStoryboardVideoPlan(
  fs: VideocityFs,
  projectSlug: string,
): Promise<StoryboardVideoPlanSidecar> {
  const planRead = await fs.readFile("plan", ".plan.json", projectSlug);
  if (!planRead.ok) throw new Error(`No plan in ${projectSlug}: ${planRead.error.message}`);
  let plan: StoryboardVideoPlanSidecar;
  try {
    plan = JSON.parse(Buffer.from(planRead.value).toString("utf-8")) as StoryboardVideoPlanSidecar;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid .plan.json: ${msg}`);
  }
  if (plan.formula !== "storyboard_video") throw new Error("Active plan is not an image -> storyboard -> video plan");
  return plan;
}

export async function generateStoryboardVideoPlan(
  fs: VideocityFs,
  args: {
    projectSlug: string;
    sourceImageAssetId: string;
    storyboardPrompt?: string;
    videoPrompt?: string;
    videoModel?: "generate_seedance2_video" | "generate_seedance2_fast_video";
    durationS?: number;
  },
): Promise<StoryboardVideoPlanSidecar> {
  const sourceImageAssetId = args.sourceImageAssetId.replace(/^@/, "");
  await assertImageAsset(fs, args.projectSlug, sourceImageAssetId, "source_image_asset_id");

  let existing: StoryboardVideoPlanSidecar | null = null;
  try {
    existing = await readStoryboardVideoPlan(fs, args.projectSlug);
  } catch {
    existing = null;
  }
  const sameSource = existing?.source_image_asset_id === sourceImageAssetId;
  const durationS = Math.min(15, Math.max(4, args.durationS ?? existing?.duration_s ?? 15));

  const sidecar: StoryboardVideoPlanSidecar = {
    formula: "storyboard_video",
    source_image_asset_id: sourceImageAssetId,
    storyboard_prompt: args.storyboardPrompt?.trim() || existing?.storyboard_prompt || DEFAULT_STORYBOARD_PROMPT,
    video_prompt: args.videoPrompt?.trim() || existing?.video_prompt || DEFAULT_VIDEO_PROMPT,
    storyboard_asset_id: sameSource ? existing?.storyboard_asset_id ?? null : null,
    video_asset_id: sameSource ? existing?.video_asset_id ?? null : null,
    storyboard_model: "generate_gpt_image",
    video_model: args.videoModel ?? existing?.video_model ?? "generate_seedance2_video",
    duration_s: durationS,
    aspect_ratio: "16:9",
    resolution: "720p",
    total_duration_s: durationS,
  };

  await writeStoryboardVideoPlan(fs, args.projectSlug, sidecar);
  return sidecar;
}
