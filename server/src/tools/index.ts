import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import type { ToolDef } from "./tool-def.js";
import { apiStatusDef } from "./api-status.js";
import { createProjectDef } from "./create-project.js";
import { renameProjectDef } from "./rename-project.js";
import { switchProjectDef } from "./switch-project.js";
import { listProjectsDef } from "./list-projects.js";
import { getDefaultProjectDef } from "./get-default-project.js";
import { uploadFileDef } from "./upload-file.js";
import { assetManifestDef } from "./asset-manifest.js";
import { deleteAssetDef } from "./delete-asset.js";
import { renameAssetDef } from "./rename-asset.js";
import { duplicateAssetDef } from "./duplicate-asset.js";
import { exportAssetDef } from "./export-asset.js";
import { projectHistoryDef } from "./project-history.js";
import { assetHistoryDef } from "./asset-history.js";
import { restoreAssetVersionDef } from "./restore-asset-version.js";
import { rewindProjectDef } from "./rewind-project.js";
import { trimVideoDef } from "./trim-video.js";
import { downloadVideoDef } from "./download-video.js";
import { changeVideoSpeedDef } from "./change-video-speed.js";
import { reverseVideoDef } from "./reverse-video.js";
import { extractFrameDefs } from "./extract-frame.js";
import { extractAudioDef } from "./extract-audio.js";
import { transcribeDef } from "./transcribe.js";
import { generateGrokImagineVideoDef } from "./generate-grok-imagine-video.js";
import { generateNanoBananaImageDef } from "./generate-nano-banana-image.js";
import { renderVideoDef } from "./render-video.js";
import { syncDef } from "./sync.js";
import { listAssetsDef } from "./list-assets.js";
import { sleepDef } from "./sleep.js";
import { whitelistDef } from "./whitelist-asset.js";
import { previewVideoGenDef } from "./preview-video-gen.js";
import { previewImageGenDef } from "./preview-image-gen.js";
import { generateGrokImagineImageDef } from "./generate-grok-imagine-image.js";
import { generateGptImageDef } from "./generate-gpt-image.js";
import { chatDef } from "./chat.js";
import { getTimelineDef } from "./get-timeline.js";
import { editTimelineDef } from "./edit-timeline.js";
import { renderTimelineDef } from "./render-timeline.js";
import { redesignStyleguidePageDef } from "./redesign-styleguide-page.js";
import { openFolderDef } from "./open-folder.js";
import { commandsDef } from "./commands.js";
import { slugsDef } from "./slugs.js";
import { pushChatHistoryDef, listChatHistoryDef } from "./chat-history.js";
import { withLogging } from "./log-wrapper.js";

export function registerAllTools(server: McpServer, fs: ClipfirstFs): void {
  const defs = getAllToolDefs(fs).map((def) => withLogging(def, fs));
  for (const def of defs) {
    server.tool(def.name, def.description, def.schema, def.handler);
  }
}

export function getAllToolDefs(fs: ClipfirstFs): ToolDef[] {
  return [
    apiStatusDef(),
    createProjectDef(fs),
    renameProjectDef(fs),
    switchProjectDef(fs),
    listProjectsDef(fs),
    getDefaultProjectDef(fs),
    uploadFileDef(fs),
    assetManifestDef(fs),
    deleteAssetDef(fs),
    renameAssetDef(fs),
    duplicateAssetDef(fs),
    exportAssetDef(fs),
    projectHistoryDef(fs),
    assetHistoryDef(fs),
    restoreAssetVersionDef(fs),
    rewindProjectDef(fs),
    trimVideoDef(fs),
    downloadVideoDef(fs),
    changeVideoSpeedDef(fs),
    reverseVideoDef(fs),
    ...extractFrameDefs(fs),
    extractAudioDef(fs),
    transcribeDef(fs),
    generateGrokImagineVideoDef(fs),
    generateNanoBananaImageDef(fs),
    renderVideoDef(fs),
    syncDef(fs),
    listAssetsDef(fs),
    sleepDef(fs),
    whitelistDef(fs),
    previewVideoGenDef(fs),
    previewImageGenDef(fs),
    generateGrokImagineImageDef(fs),
    generateGptImageDef(fs),
    chatDef(fs),
    getTimelineDef(fs),
    editTimelineDef(fs),
    renderTimelineDef(fs),
    redesignStyleguidePageDef(),
    openFolderDef(fs),
    commandsDef(fs),
    slugsDef(fs),
    pushChatHistoryDef(fs),
    listChatHistoryDef(fs),
  ];
}
