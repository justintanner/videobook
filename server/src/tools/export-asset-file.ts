import type { Engine } from "videobook-engine";
import { z } from "zod";
import { copyFileToClipboardDef } from "./copy-file-to-clipboard.js";
import { exportToDownloadsDef } from "./export-to-downloads.js";
import { showFolderDef } from "./show-folder.js";
import type { ToolDef } from "./tool-def.js";

const DESTINATIONS = ["downloads", "clipboard", "finder"] as const;

type Destination = typeof DESTINATIONS[number];

export function exportAssetFileDef(engine: Engine): ToolDef {
  const handlers: Record<Destination, ToolDef["handler"]> = {
    downloads: exportToDownloadsDef(engine).handler,
    clipboard: copyFileToClipboardDef(engine).handler,
    finder: showFolderDef(engine).handler,
  };
  return {
    name: "export_asset_file",
    description: "Hand an asset's original media file to macOS: copy it to Downloads, put it on the pasteboard as a file, or reveal its folder in Finder.",
    schema: {
      book_id: z.string().describe("Book id"),
      asset_id: z.string().describe("Artifact id"),
      to: z.enum(DESTINATIONS),
    },
    handler: async (args) => handlers[args.to as Destination](args),
  };
}
