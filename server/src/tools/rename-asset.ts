import type { VideocityFs } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

type AudioRenameSnapshot = {
  assetId: string;
  filenames: string[];
  waveform: number[] | null;
};

async function captureAudioRename(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
): Promise<AudioRenameSnapshot | null> {
  const cleanId = assetId.replace(/^@/, "");
  if (!cleanId.startsWith("aud-")) return null;

  const manifest = await fs.getManifest(cleanId, projectSlug, { includeDotfiles: true });
  if (!manifest.ok) return null;
  const waveform = await fs.readAudioWaveform(cleanId, projectSlug);
  return {
    assetId: cleanId,
    filenames: manifest.value.files.map((file) => file.name),
    waveform: waveform.ok ? waveform.value.peaks : null,
  };
}

async function repairAudioRename(
  fs: VideocityFs,
  snapshot: AudioRenameSnapshot,
  newAssetId: string,
  projectSlug: string,
): Promise<string | null> {
  const newManifest = await fs.getManifest(newAssetId, projectSlug, { includeDotfiles: true });
  if (!newManifest.ok) return `Renamed audio asset is unreadable: ${newManifest.error.message}`;

  const oldManifest = await fs.getManifest(snapshot.assetId, projectSlug, { includeDotfiles: true });
  if (oldManifest.ok && oldManifest.value.path !== newManifest.value.path) {
    const newNames = new Set(newManifest.value.files.map((file) => file.name));
    const oldNames = new Set(oldManifest.value.files.map((file) => file.name));
    for (const filename of snapshot.filenames) {
      if (newNames.has(filename) || !oldNames.has(filename)) continue;
      const copied = await fs.copyFile(snapshot.assetId, filename, newAssetId, filename, projectSlug);
      if (!copied.ok) return `Failed to preserve ${filename} during audio rename: ${copied.error.message}`;
      newNames.add(filename);
    }

    const missing = snapshot.filenames.filter((filename) => !newNames.has(filename));
    if (missing.length > 0) return `Audio rename lost files: ${missing.join(", ")}`;

    const deleted = await fs.deleteAsset(snapshot.assetId, projectSlug);
    if (!deleted.ok) return `Failed to remove old audio asset after rename: ${deleted.error.message}`;
  }

  if (snapshot.waveform !== null) {
    const waveform = await fs.writeAudioWaveform(newAssetId, snapshot.waveform, projectSlug);
    if (!waveform.ok) return `Failed to preserve audio waveform during rename: ${waveform.error.message}`;
  }
  return null;
}

export function renameAssetDef(fs: VideocityFs): ToolDef {
  return {
    name: "rename_asset",
    description: "Rename an asset with a new name",
    schema: {
      asset_id: z.string().describe("Asset ID to rename (e.g. img-cute-cat)"),
      new_name: z.string().describe("New name for slug generation (e.g. sunset beach)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { asset_id, new_name, project_slug } = args as { asset_id: string; new_name: string; project_slug: string };
      const audioSnapshot = await captureAudioRename(fs, asset_id, project_slug);
      const result = await fs.renameAsset(asset_id, new_name, project_slug);
      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.error.message }],
        };
      }

      if (audioSnapshot !== null) {
        const repairError = await repairAudioRename(
          fs,
          audioSnapshot,
          result.value.new_asset_id,
          project_slug,
        );
        if (repairError !== null) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: repairError }],
          };
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            old_asset_id: result.value.old_asset_id,
            new_asset_id: result.value.new_asset_id,
          }),
        }],
      };
    },
  };
}
