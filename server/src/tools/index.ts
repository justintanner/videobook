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
import { readFileAtCommitDef } from "./read-file-at-commit.js";
import { readAssetMetadataDef } from "./read-asset-metadata.js";
import { rewindProjectDef } from "./rewind-project.js";
import { trimVideoDef } from "./trim-video.js";
import { downloadVideoDef } from "./download-video.js";
import { changeVideoSpeedDef } from "./change-video-speed.js";
import { reverseVideoDef } from "./reverse-video.js";
import { extractFrameDefs } from "./extract-frame.js";
import { extractAudioDef } from "./extract-audio.js";
import { replaceVideoAudioDef } from "./replace-video-audio.js";
import { spliceVideoDef } from "./splice-video.js";
import { transcribeDef } from "./transcribe.js";
import { generateGrokImagineVideoDef } from "./generate-grok-imagine-video.js";
import { generateGrokImagineRefVideoDef } from "./generate-grok-imagine-ref-video.js";
import { extendGrokImagineVideoDef } from "./extend-grok-imagine-video.js";
import { upscaleGrokImagineVideoDef } from "./upscale-grok-imagine-video.js";
import { generateKling30VideoDef } from "./generate-kling30-video.js";
import { generateSeedance2T2vVideoDef } from "./generate-seedance2-t2v-video.js";
import { generateSeedance2I2vVideoDef } from "./generate-seedance2-i2v-video.js";
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
import { generateSeedreamTextImageDef } from "./generate-seedream-text-image.js";
import { generateSeedreamImageDef } from "./generate-seedream-image.js";
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
import { generateGptImageTextDef } from "./generate-gpt-image-text.js";
import { generateAlibabaImageDef } from "./generate-alibaba-image.js";
import { generateAlibabaImageProDef } from "./generate-alibaba-image-pro.js";
import { generateAlibabaQwenImageDef } from "./generate-alibaba-qwen-image.js";
import { generateAlibabaQwenImageEditDef } from "./generate-alibaba-qwen-image-edit.js";
import { generateAlibabaVideoDef } from "./generate-alibaba-video.js";
import { chatDef } from "./chat.js";
import { getTimelineDef } from "./get-timeline.js";
import { editTimelineDef } from "./edit-timeline.js";
import { renderTimelineDef } from "./render-timeline.js";
import { showFolderDef } from "./show-folder.js";
import { copyFileToClipboardDef } from "./copy-file-to-clipboard.js";
import { exportToDownloadsDef } from "./export-to-downloads.js";
import { slugsDef } from "./slugs.js";
import { pushChatHistoryDef, listChatHistoryDef } from "./chat-history.js";
import { rewritePromptDef } from "./rewrite-prompt.js";
import { describeImageDef } from "./describe-image.js";
import { rewriteScriptDef } from "./rewrite-script.js";
import { isolateVocalsDef } from "./isolate-vocals.js";
import { assignSlotDef } from "./assign-slot.js";
import { clearSlotDef } from "./clear-slot.js";
import { addTimelineAudioDef } from "./add-timeline-audio.js";
import { removeTimelineAudioDef } from "./remove-timeline-audio.js";
import { moveTimelineAudioDef } from "./move-timeline-audio.js";
import { updateTimelineAudioDef } from "./update-timeline-audio.js";
import { commandsDef } from "./commands.js";
import { renderSettingsDef } from "./render-settings.js";
import { translatePayloadDef } from "./translate-payload.js";
import { updateScriptDef } from "./update-script.js";
import { generateSeedance2I2vFalDef } from "./generate-seedance2-i2v-fal.js";
import { generateSeedance2T2vFalDef } from "./generate-seedance2-t2v-fal.js";
import { generateNanoBananaProFalDef } from "./generate-nano-banana-pro-fal.js";
import { generateNanoBananaProEditFalDef } from "./generate-nano-banana-pro-edit-fal.js";
import { generateSeedreamV5LiteFalDef } from "./generate-seedream-v5-lite-fal.js";
import { generateSeedreamV5LiteEditFalDef } from "./generate-seedream-v5-lite-edit-fal.js";
import { generateWan27FalDef } from "./generate-wan27-fal.js";
import { generateWan27EditFalDef } from "./generate-wan27-edit-fal.js";
import { generateWan27ProFalDef } from "./generate-wan27-pro-fal.js";
import { generateWan27ProEditFalDef } from "./generate-wan27-pro-edit-fal.js";
import { generateGrokImagineImageFalDef } from "./generate-grok-imagine-image-fal.js";
import { generateGrokImagineImageEditFalDef } from "./generate-grok-imagine-image-edit-fal.js";
import { generateKlingV3ProI2vFalDef } from "./generate-kling-v3-pro-i2v-fal.js";
import { generateGrokImagineVideoI2vFalDef } from "./generate-grok-imagine-video-i2v-fal.js";
import { generateNanoBananaFalDef } from "./generate-nano-banana-fal.js";
import { generateNanoBananaEditFalDef } from "./generate-nano-banana-edit-fal.js";
import { generateNanoBanana2FalDef } from "./generate-nano-banana-2-fal.js";
import { generateNanoBanana2EditFalDef } from "./generate-nano-banana-2-edit-fal.js";
import { generateQwenImageFalDef } from "./generate-qwen-image-fal.js";
import { generateQwenImageEditFalDef } from "./generate-qwen-image-edit-fal.js";
import { generateSeedance2FastT2vFalDef } from "./generate-seedance2-fast-t2v-fal.js";
import { generateSeedance2FastI2vFalDef } from "./generate-seedance2-fast-i2v-fal.js";
import { generateWan27T2vFalDef } from "./generate-wan27-t2v-fal.js";
import { generateWan27I2vFalDef } from "./generate-wan27-i2v-fal.js";
import { generateKlingV3ProT2vFalDef } from "./generate-kling-v3-pro-t2v-fal.js";
import { generateKlingV3StandardT2vFalDef } from "./generate-kling-v3-standard-t2v-fal.js";
import { generateKlingV3StandardI2vFalDef } from "./generate-kling-v3-standard-i2v-fal.js";
import { generateWan27R2vFalDef } from "./generate-wan27-r2v-fal.js";
import { generateWan27VideoeditFalDef } from "./generate-wan27-videoedit-fal.js";
import { generateSeedance2R2vFalDef } from "./generate-seedance2-r2v-fal.js";
import { generateSeedance2FastR2vFalDef } from "./generate-seedance2-fast-r2v-fal.js";
import { generateGrokImagineVideoR2vFalDef } from "./generate-grok-imagine-video-r2v-fal.js";
import { generateGrokImagineVideoExtendFalDef } from "./generate-grok-imagine-video-extend-fal.js";
import { generateGrokImagineVideoEditFalDef } from "./generate-grok-imagine-video-edit-fal.js";
import { genImagesAllDef } from "./gen-images-all.js";
import { generateOutfitDef, previewOutfitPromptsDef } from "./generate-outfit.js";
import { generateCharacterDef } from "./generate-character.js";
import { analyzeCharacterImageDef } from "./analyze-character-image.js";
import { suggestEditsDef } from "./suggest-edits.js";
import { pinCharacterSlotDef, unpinCharacterSlotDef } from "./pin-character-slot.js";
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
    readFileAtCommitDef(fs),
    readAssetMetadataDef(fs),
    rewindProjectDef(fs),
    trimVideoDef(fs),
    downloadVideoDef(fs),
    changeVideoSpeedDef(fs),
    reverseVideoDef(fs),
    ...extractFrameDefs(fs),
    extractAudioDef(fs),
    replaceVideoAudioDef(fs),
    spliceVideoDef(fs),
    transcribeDef(fs),
    generateGrokImagineVideoDef(fs),
    generateGrokImagineRefVideoDef(fs),
    extendGrokImagineVideoDef(fs),
    upscaleGrokImagineVideoDef(fs),
    generateKling30VideoDef(fs),
    generateSeedance2T2vVideoDef(fs),
    generateSeedance2I2vVideoDef(fs),
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
    generateSeedreamTextImageDef(fs),
    generateSeedreamImageDef(fs),
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
    generateGptImageTextDef(fs),
    generateAlibabaImageDef(fs),
    generateAlibabaImageProDef(fs),
    generateAlibabaQwenImageDef(fs),
    generateAlibabaQwenImageEditDef(fs),
    generateAlibabaVideoDef(fs),
    chatDef(fs),
    getTimelineDef(fs),
    editTimelineDef(fs),
    renderTimelineDef(fs),
    showFolderDef(fs),
    copyFileToClipboardDef(fs),
    exportToDownloadsDef(fs),
    slugsDef(fs),
    pushChatHistoryDef(fs),
    listChatHistoryDef(fs),
    rewritePromptDef(fs),
    describeImageDef(fs),
    rewriteScriptDef(fs),
    isolateVocalsDef(fs),
    assignSlotDef(fs),
    clearSlotDef(fs),
    addTimelineAudioDef(fs),
    removeTimelineAudioDef(fs),
    moveTimelineAudioDef(fs),
    updateTimelineAudioDef(fs),
    commandsDef(fs),
    renderSettingsDef(fs),
    translatePayloadDef(),
    updateScriptDef(fs),
    generateSeedance2I2vFalDef(fs),
    generateSeedance2T2vFalDef(fs),
    generateNanoBananaProFalDef(fs),
    generateNanoBananaProEditFalDef(fs),
    generateSeedreamV5LiteFalDef(fs),
    generateSeedreamV5LiteEditFalDef(fs),
    generateWan27FalDef(fs),
    generateWan27EditFalDef(fs),
    generateWan27ProFalDef(fs),
    generateWan27ProEditFalDef(fs),
    generateGrokImagineImageFalDef(fs),
    generateGrokImagineImageEditFalDef(fs),
    generateKlingV3ProI2vFalDef(fs),
    generateGrokImagineVideoI2vFalDef(fs),
    generateNanoBananaFalDef(fs),
    generateNanoBananaEditFalDef(fs),
    generateNanoBanana2FalDef(fs),
    generateNanoBanana2EditFalDef(fs),
    generateQwenImageFalDef(fs),
    generateQwenImageEditFalDef(fs),
    generateSeedance2FastT2vFalDef(fs),
    generateSeedance2FastI2vFalDef(fs),
    generateWan27T2vFalDef(fs),
    generateWan27I2vFalDef(fs),
    generateKlingV3ProT2vFalDef(fs),
    generateKlingV3StandardT2vFalDef(fs),
    generateKlingV3StandardI2vFalDef(fs),
    generateWan27R2vFalDef(fs),
    generateWan27VideoeditFalDef(fs),
    generateSeedance2R2vFalDef(fs),
    generateSeedance2FastR2vFalDef(fs),
    generateGrokImagineVideoR2vFalDef(fs),
    generateGrokImagineVideoExtendFalDef(fs),
    generateGrokImagineVideoEditFalDef(fs),
    genImagesAllDef(fs),
    generateOutfitDef(fs),
    previewOutfitPromptsDef(fs),
    generateCharacterDef(fs),
    analyzeCharacterImageDef(fs),
    suggestEditsDef(fs),
    pinCharacterSlotDef(fs),
    unpinCharacterSlotDef(fs),
  ];
}
