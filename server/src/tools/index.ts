import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import type { ToolDef } from "./tool-def.js";
import { registerApiStatusTool, apiStatusDef } from "./api-status.js";
import { registerCreateProjectTool, createProjectDef } from "./create-project.js";
import { registerListProjectsTool, listProjectsDef } from "./list-projects.js";
import { registerGetDefaultProjectTool, getDefaultProjectDef } from "./get-default-project.js";
import { registerUploadFileTool, uploadFileDef } from "./upload-file.js";
import { registerAssetManifestTool, assetManifestDef } from "./asset-manifest.js";
import { registerDeleteAssetTool, deleteAssetDef } from "./delete-asset.js";
import { registerRenameAssetTool, renameAssetDef } from "./rename-asset.js";
import { registerDuplicateAssetTool, duplicateAssetDef } from "./duplicate-asset.js";
import { registerExportAssetTool, exportAssetDef } from "./export-asset.js";
import { registerProjectHistoryTool, projectHistoryDef } from "./project-history.js";
import { registerAssetHistoryTool, assetHistoryDef } from "./asset-history.js";
import { registerRestoreAssetVersionTool, restoreAssetVersionDef } from "./restore-asset-version.js";
import { registerRewindProjectTool, rewindProjectDef } from "./rewind-project.js";
import { registerTrimVideoTool, trimVideoDef } from "./trim-video.js";
import { registerDownloadVideoTool, downloadVideoDef } from "./download-video.js";
import { registerChangeVideoSpeedTool, changeVideoSpeedDef } from "./change-video-speed.js";
import { registerReverseVideoTool, reverseVideoDef } from "./reverse-video.js";
import { registerExtractFrameTools, extractFrameDefs } from "./extract-frame.js";
import { registerExtractAudioTool, extractAudioDef } from "./extract-audio.js";
import { registerTranscribeTool, transcribeDef } from "./transcribe.js";
import { registerGenerateGrokImagineVideoTool, generateGrokImagineVideoDef } from "./generate-grok-imagine-video.js";
import { registerGenerateNanoBananaImageTool, generateNanoBananaImageDef } from "./generate-nano-banana-image.js";
import { registerRenderVideoTool, renderVideoDef } from "./render-video.js";
import { registerSyncTool, syncDef } from "./sync.js";
import { registerWhitelistTool, whitelistDef } from "./whitelist-asset.js";

export function registerAllTools(server: McpServer, fs: ClipfirstFs): void {
  registerApiStatusTool(server);
  registerCreateProjectTool(server, fs);
  registerListProjectsTool(server, fs);
  registerGetDefaultProjectTool(server, fs);
  registerUploadFileTool(server, fs);
  registerAssetManifestTool(server, fs);
  registerDeleteAssetTool(server, fs);
  registerRenameAssetTool(server, fs);
  registerDuplicateAssetTool(server, fs);
  registerExportAssetTool(server, fs);
  registerProjectHistoryTool(server, fs);
  registerAssetHistoryTool(server, fs);
  registerRestoreAssetVersionTool(server, fs);
  registerRewindProjectTool(server, fs);
  registerTrimVideoTool(server, fs);
  registerDownloadVideoTool(server, fs);
  registerChangeVideoSpeedTool(server, fs);
  registerReverseVideoTool(server, fs);
  registerExtractFrameTools(server, fs);
  registerExtractAudioTool(server, fs);
  registerTranscribeTool(server, fs);
  registerGenerateGrokImagineVideoTool(server, fs);
  registerGenerateNanoBananaImageTool(server, fs);
  registerRenderVideoTool(server, fs);
  registerSyncTool(server, fs);
  registerWhitelistTool(server, fs);
}

export function getAllToolDefs(fs: ClipfirstFs): ToolDef[] {
  return [
    apiStatusDef(),
    createProjectDef(fs),
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
    whitelistDef(fs),
  ];
}
