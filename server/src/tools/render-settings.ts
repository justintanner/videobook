import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { readLanguageCode, iso1FromIso3 } from "../jobs/_translate-transcript.js";
import { readRenderSettings, RENDER_ORIENTATIONS } from "./sync.js";

type TranscriptInfo = {
  sourceLanguageCode: string | null;
  sourceLanguage: string | null;
  cachedTranslations: string[];
};

const TRANSLATED_SIDECAR_RE = /^elevenlabs\.([a-z]{2})\.json$/;

async function readTranscriptInfo(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
): Promise<TranscriptInfo> {
  const info: TranscriptInfo = { sourceLanguageCode: null, sourceLanguage: null, cachedTranslations: [] };

  const manifestResult = await fs.getManifest(assetId, projectSlug);
  if (manifestResult.ok) {
    for (const file of manifestResult.value.files) {
      const match = TRANSLATED_SIDECAR_RE.exec(file.name);
      if (match) info.cachedTranslations.push(match[1]);
    }
  }

  const transcriptResult = await fs.readFile(assetId, "elevenlabs.json", projectSlug);
  if (transcriptResult.ok) {
    try {
      const raw = JSON.parse(transcriptResult.value.toString()) as unknown;
      info.sourceLanguageCode = readLanguageCode(raw);
      info.sourceLanguage = iso1FromIso3(info.sourceLanguageCode);
    } catch {
      // unreadable transcript — leave language unknown
    }
  }

  return info;
}

export function renderSettingsDef(fs: VideocityFs): ToolDef {
  return {
    name: "render_settings",
    description: "Fetch stored render settings for a single asset across all orientations, plus transcript language info (detected source language and cached subtitle translations)",
    schema: {
      asset_id: z.string().describe("Asset ID (e.g. vid-running-dog)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
      const [settings, transcript] = await Promise.all([
        readRenderSettings(fs, asset_id, project_slug, [...RENDER_ORIENTATIONS]),
        readTranscriptInfo(fs, asset_id, project_slug),
      ]);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ settings, transcript }) }],
      };
    },
  };
}
