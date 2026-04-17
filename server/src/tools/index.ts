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
import { clearFailedTasksDef } from "./clear-failed-tasks.js";
import { renameAssetDef } from "./rename-asset.js";
import { duplicateAssetDef } from "./duplicate-asset.js";
import { exportAssetDef } from "./export-asset.js";
import { projectHistoryDef } from "./project-history.js";
import { projectActivityDef } from "./project-activity.js";
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
import { generateGrokImagineRefVideoDef } from "./generate-grok-imagine-ref-video.js";
import { extendGrokImagineVideoDef } from "./extend-grok-imagine-video.js";
import { generateKling30VideoDef } from "./generate-kling30-video.js";
import { generateSeedance2T2vVideoDef } from "./generate-seedance2-t2v-video.js";
import { generateSeedance2FramesVideoDef } from "./generate-seedance2-frames-video.js";
import { generateSeedance2ReferenceVideoDef } from "./generate-seedance2-reference-video.js";
import { generateWan27I2vVideoDef } from "./generate-wan27-i2v-video.js";
import { generateWan27VideoeditVideoDef } from "./generate-wan27-videoedit-video.js";
import { generateWan27R2vVideoDef } from "./generate-wan27-r2v-video.js";
import { extendWan27VideoDef } from "./extend-wan27-video.js";
import { generateWan27ImageDef } from "./generate-wan27-image.js";
import { generateWan27ImageProDef } from "./generate-wan27-image-pro.js";
import { generateNanoBananaImageDef } from "./generate-nano-banana-image.js";
import { generateQwen2ImageEditDef } from "./generate-qwen2-image-edit.js";
import { renderDef } from "./render.js";
import { syncDef } from "./sync.js";
import { listAssetsDef } from "./list-assets.js";
import { sleepDef } from "./sleep.js";
import { whitelistDef } from "./whitelist-asset.js";
import { previewVideoGenDef } from "./preview-video-gen.js";
import { previewImageGenDef } from "./preview-image-gen.js";
import { generationPayloadDef } from "./generation-payload.js";
import { generateGrokImagineImageDef } from "./generate-grok-imagine-image.js";
import { generateGrokImagineTextImageDef } from "./generate-grok-imagine-text-image.js";
import { generateGptImageDef } from "./generate-gpt-image.js";
import { generateAlibabaImageDef } from "./generate-alibaba-image.js";
import { generateAlibabaImageProDef } from "./generate-alibaba-image-pro.js";
import { generateAlibabaQwenImageDef } from "./generate-alibaba-qwen-image.js";
import { generateAlibabaQwenImageEditDef } from "./generate-alibaba-qwen-image-edit.js";
import { generateAlibabaVideoDef } from "./generate-alibaba-video.js";
import { chatDef } from "./chat.js";
import { getTimelineDef } from "./get-timeline.js";
import { editTimelineDef } from "./edit-timeline.js";
import { renderTimelineDef } from "./render-timeline.js";
import { redesignStyleguidePageDef } from "./redesign-styleguide-page.js";
import { showFolderDef } from "./show-folder.js";
import { slugsDef } from "./slugs.js";
import { pushChatHistoryDef, listChatHistoryDef } from "./chat-history.js";
import { rewritePromptDef } from "./rewrite-prompt.js";
import { isolateVocalsDef } from "./isolate-vocals.js";
import { assignSlotDef } from "./assign-slot.js";
import { clearSlotDef } from "./clear-slot.js";
import { commandsDef } from "./commands.js";
import { renderSettingsDef } from "./render-settings.js";
import { translatePayloadDef } from "./translate-payload.js";
import { updateScriptDef } from "./update-script.js";
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
    clearFailedTasksDef(fs),
    renameAssetDef(fs),
    duplicateAssetDef(fs),
    exportAssetDef(fs),
    projectHistoryDef(fs),
    projectActivityDef(fs),
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
    generateGrokImagineRefVideoDef(fs),
    extendGrokImagineVideoDef(fs),
    generateKling30VideoDef(fs),
    generateSeedance2T2vVideoDef(fs),
    generateSeedance2FramesVideoDef(fs),
    generateSeedance2ReferenceVideoDef(fs),
    generateWan27I2vVideoDef(fs),
    generateWan27VideoeditVideoDef(fs),
    generateWan27R2vVideoDef(fs),
    extendWan27VideoDef(fs),
    generateWan27ImageDef(fs),
    generateWan27ImageProDef(fs),
    generateNanoBananaImageDef(fs),
    generateQwen2ImageEditDef(fs),
    renderDef(fs),
    syncDef(fs),
    listAssetsDef(fs),
    sleepDef(fs),
    whitelistDef(fs),
    previewVideoGenDef(fs),
    previewImageGenDef(fs),
    generationPayloadDef(fs),
    generateGrokImagineImageDef(fs),
    generateGrokImagineTextImageDef(fs),
    generateGptImageDef(fs),
    generateAlibabaImageDef(fs),
    generateAlibabaImageProDef(fs),
    generateAlibabaQwenImageDef(fs),
    generateAlibabaQwenImageEditDef(fs),
    generateAlibabaVideoDef(fs),
    chatDef(fs),
    getTimelineDef(fs),
    editTimelineDef(fs),
    renderTimelineDef(fs),
    redesignStyleguidePageDef(),
    showFolderDef(fs),
    slugsDef(fs),
    pushChatHistoryDef(fs),
    listChatHistoryDef(fs),
    rewritePromptDef(fs),
    isolateVocalsDef(fs),
    assignSlotDef(fs),
    clearSlotDef(fs),
    commandsDef(fs),
    renderSettingsDef(fs),
    translatePayloadDef(),
    updateScriptDef(fs),
  ];
}
