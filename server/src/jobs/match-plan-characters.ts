import type { VideocityFs } from "videocity-engine";
import { extname } from "node:path";
import type { KieGeminiPart } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { getApiKey } from "../api-key.js";
import { findImageFile } from "../tools/_image-inputs.js";
import { callGeminiFlashJson, geminiImageBase64Part, geminiTextPart } from "../kie-gemini.js";

type FrameCharacters = { image1?: string[]; image2?: string[] };

type PlanScene = {
  start: number;
  end: number;
  visual: string;
  frame_characters?: FrameCharacters | null;
};

type PlanSidecar = {
  scenes: PlanScene[];
  characters: Array<{ asset_id: string; name: string; description: string }>;
};

export interface MatchPlanCharactersPayload {
  projectSlug: string;
  // null → match every scene; otherwise just this zero-based scene index.
  sceneIndex: number | null;
}

type CharImage = {
  assetId: string;
  name: string;
  description: string;
  base64: string;
  mime: string;
};

const SYSTEM_PROMPT_MATCH =
  "You match reference characters to the people visible in a film still. " +
  "You receive a SOURCE FRAME followed by one or more CHARACTER reference images in a stated order. " +
  "Decide which reference character(s) correspond to the prominent on-screen person(s) in the source frame. " +
  "Return their ids ordered by on-screen prominence (most prominent first), at most two. " +
  "Include a character only if a person plausibly playing that role is actually visible; if two distinct people are " +
  "visible and both references map, return both. Always return at least one id — your single best guess — even when unsure.";

function mimeFromName(name: string): string {
  const ext = extname(name).replace(/^\./, "").toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

async function loadCharImages(
  fs: VideocityFs,
  characters: PlanSidecar["characters"],
  projectSlug: string,
): Promise<CharImage[]> {
  const out: CharImage[] = [];
  for (const c of characters) {
    const manifest = await fs.getManifest(c.asset_id, projectSlug);
    if (!manifest.ok) throw new Error(`Character ${c.asset_id} not found: ${manifest.error.message}`);
    const imageFile = findImageFile(manifest.value.files);
    if (!imageFile) throw new Error(`No image file found in character asset ${c.asset_id}`);
    const read = await fs.readFile(c.asset_id, imageFile.name, projectSlug);
    if (!read.ok) throw new Error(`Failed to read ${c.asset_id}/${imageFile.name}: ${read.error.message}`);
    out.push({
      assetId: c.asset_id,
      name: c.name,
      description: c.description,
      base64: Buffer.from(read.value).toString("base64"),
      mime: mimeFromName(imageFile.name),
    });
  }
  return out;
}

async function classifyFrame(
  apiKey: string,
  charImages: CharImage[],
  sourceBase64: string,
): Promise<string[]> {
  const ids = charImages.map((c) => c.assetId);
  const charBlock = charImages
    .map((c, i) => `Character ${i + 1}: id="${c.assetId}", name="${c.name}"${c.description ? `, ${c.description}` : ""}`)
    .join("\n");

  const userContent: KieGeminiPart[] = [
    geminiTextPart(
      `The first image is the SOURCE FRAME (a still from a film scene). ` +
        `The following ${charImages.length} image(s) are CHARACTER references, in this order:\n${charBlock}\n\n` +
        `Return character_asset_ids: the reference id(s) that match the prominent on-screen person(s) in the SOURCE FRAME, ` +
        `ordered by prominence (most prominent first), at most two, at least one.`,
    ),
    geminiImageBase64Part(sourceBase64, "image/jpeg"),
    ...charImages.map((c) => geminiImageBase64Part(c.base64, c.mime)),
  ];

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      character_asset_ids: {
        type: "array",
        items: { type: "string", enum: ids },
        description: "Matching character ids, most prominent first (1–2).",
      },
    },
    required: ["character_asset_ids"],
  };

  const outputText = await callGeminiFlashJson({
    apiKey,
    parts: [
      geminiTextPart(`Instructions:\n${SYSTEM_PROMPT_MATCH}`),
      ...userContent,
    ],
    maxOutputTokens: 2048,
    responseSchema: schema as unknown as Record<string, unknown>,
  });

  let parsed: { character_asset_ids?: string[] };
  try {
    parsed = JSON.parse(outputText) as { character_asset_ids?: string[] };
  } catch {
    return [ids[0]];
  }
  const known = new Set(ids);
  const deduped: string[] = [];
  for (const id of parsed.character_asset_ids ?? []) {
    if (known.has(id) && !deduped.includes(id)) deduped.push(id);
  }
  if (deduped.length === 0) return [ids[0]];
  return deduped.slice(0, 2);
}

export function registerMatchPlanCharactersJob(fs: VideocityFs): void {
  registerJobHandler("match_plan_characters", async (payload) => {
    const { projectSlug, sceneIndex } = payload as unknown as MatchPlanCharactersPayload;

    const apiKey = getApiKey("KIE_API_KEY");
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const planRead = await fs.readFile("plan", ".plan.json", projectSlug);
    if (!planRead.ok) throw new Error(`No plan in ${projectSlug}: ${planRead.error.message}`);
    const plan = JSON.parse(Buffer.from(planRead.value).toString("utf-8")) as PlanSidecar;
    if (!plan.characters || plan.characters.length === 0) {
      throw new Error("Plan has no characters to match");
    }

    const charImages = await loadCharImages(fs, plan.characters, projectSlug);

    const targetIndices =
      sceneIndex == null ? plan.scenes.map((_, i) => i) : [sceneIndex];

    const matched = new Map<string, string[]>();
    for (const s of targetIndices) {
      if (!plan.scenes[s]) continue;
      for (const f of [1, 2] as const) {
        const srcName = `s${s + 1}-image${f}-source.jpg`;
        const srcRead = await fs.readFile("plan", srcName, projectSlug);
        if (!srcRead.ok) continue; // source frame not extracted — skip this frame
        const ids = await classifyFrame(apiKey, charImages, Buffer.from(srcRead.value).toString("base64"));
        matched.set(`${s}:${f}`, ids);
      }
    }

    const freshRead = await fs.readFile("plan", ".plan.json", projectSlug);
    if (!freshRead.ok) throw new Error(`Failed to re-read plan: ${freshRead.error.message}`);
    const fresh = JSON.parse(Buffer.from(freshRead.value).toString("utf-8")) as PlanSidecar;

    let applied = 0;
    for (const [key, ids] of matched) {
      const [sStr, fStr] = key.split(":");
      const s = Number(sStr);
      const f = Number(fStr) as 1 | 2;
      const scene = fresh.scenes[s];
      if (!scene) continue;
      const fc: FrameCharacters = { ...(scene.frame_characters ?? {}) };
      fc[`image${f}` as "image1" | "image2"] = ids;
      fresh.scenes[s] = { ...scene, frame_characters: fc };
      applied++;
    }

    const write = await fs.writeFile("plan", ".plan.json", JSON.stringify(fresh, null, 2), projectSlug);
    if (!write.ok) throw new Error(`Failed to update .plan.json: ${write.error.message}`);

    return { success: true, frames_matched: applied, scenes_targeted: targetIndices.length };
  });
}
