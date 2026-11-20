import { FRONTIER_TYPES, frontier } from "@apicity/cost";
import { describe, expect, it } from "vitest";
import { listNotebookActions } from "../notebook-action-catalog.js";
import { resolveModel } from "./descriptor.js";
import { frontierCatalogId } from "./frontier.js";
import { listModels, modelListing } from "./listing.js";
import { modelFamily, type ModelFamilyFields } from "./model-family.js";
import type { Media } from "./types.js";

const FAMILY_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  "image:gpt-image-2-6-sunburst": [
    "fal:openai/gpt-image-2.6/sunburst/text-to-image",
    "fal:openai/gpt-image-2.6/sunburst/edit",
    "kie:gpt-image-2-6/sunburst-text-to-image",
    "kie:gpt-image-2-6/sunburst-image-to-image",
    "machgen:GPT-Image-2.6-Sunburst",
    "wavespeed:openai/gpt-image-2.6-sunburst/text-to-image",
    "wavespeed:openai/gpt-image-2.6-sunburst/edit",
  ],
  "image:nano-banana-2-1": [
    "kie:nano-banana-2-1",
    "fal:google/nano-banana-2.1",
    "fal:google/nano-banana-2.1/edit",
    "machgen:Nano-Banana-2.1",
    "wavespeed:google/nano-banana-2.1/text-to-image",
    "wavespeed:google/nano-banana-2.1/edit",
    "nunchux:gemini-nano-banana-2.1",
  ],
  "image:grok-imagine-image-2-0": ["xai:grok-imagine-image-2.0", "wavespeed:x-ai/grok-imagine-image-v2.0/text-to-image"],
  "image:seedream-5-5": ["kie:seedream/5-5-image-to-image", "wavespeed:bytedance/seedream-v5.5/edit"],
  "image:minimax-h3-image": ["kie:minimax-h3/text-to-image", "kie:minimax-h3/image-edit"],
  "video:minimax-h3": [
    "kie:minimax-h3/text-to-video",
    "fal:minimax/h3/image-to-video",
    "machgen:MiniMax-H3",
    "wavespeed:minimax/h3/image-to-video",
    "wavespeed:minimax/h3/reference-to-video",
    "nunchux:MiniMax-H3",
  ],
  "video:seedance-2-5": [
    "kie:bytedance/seedance-2-5",
    "fal:bytedance/seedance-2.5/text-to-video",
    "machgen:Seedance-2.5",
    "wavespeed:bytedance/seedance-2.5/image-to-video",
    "nunchux:dreamina-seedance-2-5-260628",
  ],
  "video:seedance-2-0": [
    "fal:bytedance/seedance-2.0/text-to-video",
    "machgen:Seedance-2.0",
    "wavespeed:bytedance/seedance-2.0/reference-to-video",
    "nunchux:dreamina-seedance-2-0-260128",
  ],
  "video:wan-3-0": [
    "kie:wan/3-0-video",
    "fal:alibaba/wan-3.0/text-to-video",
    "machgen:Alibaba-Wan-3.0",
    "wavespeed:alibaba/wan-3.0/image-to-video",
    "nunchux:wan3.0-video",
  ],
  "video:gemini-omni-1-2-flash": [
    "kie:google/gemini-omni-flash-1-2",
    "fal:google/gemini-omni-flash/v1.2/edit",
    "wavespeed:google/gemini-omni-1.2-flash/reference-to-video",
  ],
  "video:happyhorse-1-0": [
    "fal:alibaba/happy-horse/video-edit",
    "kie:happyhorse/video-edit",
    "wavespeed:alibaba/happyhorse-1.0/video-edit",
    "nunchux:happyhorse-1.0-video-edit",
  ],
  "video:wan-2-7": ["fal:fal-ai/wan/v2.7/edit-video", "wavespeed:alibaba/wan-2.7/video-edit", "nunchux:wan2.7-videoedit"],
  "video:grok-imagine-video-1-5": [
    "xai:grok-imagine-video-1.5",
    "fal:xai/grok-imagine-video/v1.5/image-to-video",
    "machgen:Grok-Imagine-Video-1.5",
    "wavespeed:x-ai/grok-imagine-video-v1.5/reference-to-video",
  ],
  "video:veo-3-1": ["fal:fal-ai/veo3.1", "machgen:Veo-3.1"],
  "video:heygen-video": ["fal:heygen/heygen-video/text-to-video", "wavespeed:heygen/video-1.0/image-to-video"],
  "video:flux-3": ["fal:blackforestlabs/flux-3/text-to-video", "wavespeed:black-forest-labs/flux-3/image-to-video"],
};

const VARIANTS: Readonly<Record<string, readonly [string, string]>> = {
  "fal:bytedance/seedance-2.5/us/reference-to-video": ["video:seedance-2-5", "US"],
  "fal:bytedance/seedance-2.0/us/image-to-video": ["video:seedance-2-0", "US"],
  "kie:wan/3-0-video-prime": ["video:wan-3-0", "Prime"],
  "fal:alibaba/wan-3.0-prime/text-to-video": ["video:wan-3-0", "Prime"],
  "fal:blackforestlabs/flux-3/text-to-video/draft": ["video:flux-3", "Draft"],
  "fal:blackforestlabs/flux-3/first-last-frame-to-video": ["video:flux-3", "First/Last Frame"],
  "fal:minimax/h3/text-to-video/lora": ["video:minimax-h3", "LoRA"],
  "fal:minimax/h3-max-turbo/text-to-video": ["video:h3-max", "Turbo"],
};

function familyOf(id: string): ModelFamilyFields {
  return modelFamily(resolveModel(id));
}

function titled(title: string, media: Media = "video"): ModelFamilyFields {
  return modelFamily({ entry: {}, media, title });
}

describe("model family", () => {
  it("drops a trailing provider and operation from the resolved title", () => {
    expect(titled("Veo 3 (Kie)")).toEqual({ family: { id: "video:veo-3", title: "Veo 3" } });
    expect(titled("GPT Image 2.6 Sunburst Edit (WaveSpeed)", "image")).toEqual({
      family: { id: "image:gpt-image-2-6-sunburst", title: "GPT Image 2.6 Sunburst" },
    });
    expect(titled("HappyHorse 1.0 Text to Video").family.title).toBe("HappyHorse 1.0");
    expect(titled("H3 Max Reference To Video").family.title).toBe("H3 Max");
    expect(titled("Kling 3.0 Omni Image-to-Video").family.title).toBe("Kling 3.0 Omni");
    expect(titled("Kling 4.0 Keyframe-to-Video").family.title).toBe("Kling 4.0");
    expect(titled("FLUX 3 Edit Video").family.title).toBe("FLUX 3");
    expect(titled("Gemini Omni 1.2 Flash Extend").family.title).toBe("Gemini Omni 1.2 Flash");
    expect(titled("Qwen Image Edit Plus (Alibaba)", "image").family.title).toBe("Qwen Image Edit Plus");
    expect(titled("Topaz Video Generative (MachGen)").family.title).toBe("Topaz Video Generative");
  });

  it("uses the entry's family title and variant over the resolved title", () => {
    expect(modelFamily({ entry: { family: "Seedance 2.5", variant: "US" }, media: "video", title: "Seedance 2.5 US" })).toEqual({
      family: { id: "video:seedance-2-5", title: "Seedance 2.5" },
      variant: "US",
    });
  });

  it("groups one model's endpoints across providers and operations", () => {
    for (const [familyId, members] of Object.entries(FAMILY_MEMBERS)) {
      for (const id of members) {
        expect({ id, family: familyOf(id) }).toEqual({ id, family: { family: expect.objectContaining({ id: familyId }) } });
      }
    }
    expect(familyOf("fal:openai/gpt-image-2.6/sunburst/edit").family.title).toBe("GPT Image 2.6 Sunburst");
    expect(familyOf("wavespeed:minimax/h3/image-to-video").family.id).not.toBe(familyOf("kie:minimax-h3/text-to-image").family.id);
  });

  it("names a provider's endpoint flavours as variants of the family", () => {
    for (const [id, [familyId, variant]] of Object.entries(VARIANTS)) {
      expect({ id, ...familyOf(id) }).toEqual({ id, family: expect.objectContaining({ id: familyId }), variant });
    }
  });

  it("gives every family one title and tells a provider's endpoints for one operation apart", () => {
    const titles = new Map<string, Set<string>>();
    const endpoints = new Map<string, string[]>();
    for (const model of listModels({ includeHidden: true })) {
      const { family, variant } = modelFamily(model);
      titles.set(family.id, (titles.get(family.id) ?? new Set<string>()).add(family.title));
      for (const operation of model.entry.operations) {
        const key = [family.id, model.provider, operation, variant ?? ""].join("|");
        endpoints.set(key, [...(endpoints.get(key) ?? []), model.id]);
      }
    }
    expect([...titles].filter(([, set]) => set.size > 1)).toEqual([]);
    expect([...endpoints].filter(([, ids]) => ids.length > 1)).toEqual([]);
  });

  it("keeps every endpoint of one frontier leaderboard entry in one family", () => {
    const models = new Map(listModels({ includeHidden: true }).map((model) => [model.id, model]));
    const split: string[] = [];
    for (const { type } of FRONTIER_TYPES) {
      const families = new Map<string, Set<string>>();
      for (const row of frontier(type)) {
        const id = frontierCatalogId(row);
        const model = id ? models.get(id) : undefined;
        if (!model) continue;
        const key = `${type} #${row.rank} ${row.model}`;
        families.set(key, (families.get(key) ?? new Set<string>()).add(modelFamily(model).family.id));
      }
      for (const [key, ids] of families) if (ids.size > 1) split.push(`${key}: ${[...ids].join(", ")}`);
    }
    expect(split).toEqual([]);
  });

  it("puts the family on model listings and notebook actions", () => {
    expect(modelListing(resolveModel("fal:bytedance/seedance-2.5/us/text-to-video"))).toMatchObject({
      title: "Seedance 2.5 US",
      family: { id: "video:seedance-2-5", title: "Seedance 2.5" },
      variant: "US",
    });
    expect(modelListing(resolveModel("kie:bytedance/seedance-2-5"))).not.toHaveProperty("variant");
    const actions = listNotebookActions({ includeHiddenGeneration: true });
    const generation = actions.filter((action) => action.tool?.startsWith("generate_"));
    expect(generation).toHaveLength(listModels({ includeHidden: true }).length);
    expect(generation.filter((action) => !action.family)).toEqual([]);
    expect(actions.find((action) => action.id === "generation.fal:bytedance/seedance-2.5/us/text-to-video")).toMatchObject({
      family: { id: "video:seedance-2-5", title: "Seedance 2.5" },
      variant: "US",
    });
    const edits = actions.filter((action) => action.tool === "edit_image_subjects");
    expect(edits.find((action) => action.model === "nano-banana-2-1")).toMatchObject({
      title: "Nano Banana 2.1 Edit",
      family: { id: "image:nano-banana-2-1", title: "Nano Banana 2.1" },
    });
    expect(edits.length).toBeGreaterThan(2);
    expect(edits.filter((action) => action.provider !== "local" && !action.family)).toEqual([]);
    expect(edits.find((action) => action.provider === "local")).not.toHaveProperty("family");
  });
});
