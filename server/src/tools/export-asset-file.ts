import type { Engine } from "videobook-engine";
import { z } from "zod";
import { copyFileToClipboardDef } from "./copy-file-to-clipboard.js";
import { exportToDownloadsDef } from "./export-to-downloads.js";
import { showFolderDef } from "./show-folder.js";
import type { ToolDef } from "./tool-def.js";

const DESTINATIONS = ["downloads", "browser", "clipboard", "finder"] as const;

type Destination = typeof DESTINATIONS[number];

export function exportAssetFileDef(engine: Engine): ToolDef {
  const handlers: Record<Destination, ToolDef["handler"]> = {
    downloads: exportToDownloadsDef(engine).handler,
    browser: exportToDownloadsDef(engine, "browser").handler,
    clipboard: copyFileToClipboardDef(engine).handler,
    finder: showFolderDef(engine).handler,
  };
  return {
    name: "export_asset_file",
    description: "Export an asset's original media file: downloads copies it to the server's Downloads folder and returns its path; browser returns an attachment URL and filename without copying. Clipboard and Finder use macOS. The browser UI chooses browser for non-loopback pages; direct tool calls to downloads keep copying.",
    schema: {
      book_id: z.string().describe("Book id"),
      asset_id: z.string().describe("Artifact id"),
      to: z.enum(DESTINATIONS),
    },
    handler: async (args) => handlers[args.to as Destination](args),
  };
}
