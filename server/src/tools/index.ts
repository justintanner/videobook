import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Engine } from "videobook-engine";
import type { BookManager } from "../book-manager.js";
import { withBookContext } from "../book-context.js";
import { bookManager } from "../fs.js";
import type { ToolDef } from "./tool-def.js";
import { videobookDomainDefs } from "./videobook-domain.js";
import { semanticSearchDefs } from "./semantic-search.js";
import { commandPlanDefs } from "./command-plan.js";
import { exportSequenceDefs } from "./export-sequence.js";
import { apiStatusDef } from "./api-status.js";
import { providerKeyStatusDef } from "./provider-key-status.js";
import { setEnvSecretDef } from "./set-env-secret.js";
import { listElevenLabsVoicesDef } from "./list-elevenlabs-voices.js";
import {
  createGoogleFlowVoiceDef,
  listGoogleFlowVoicesDef,
  deleteGoogleFlowVoiceDef,
} from "./google-flow-voices.js";
import {
  createGoogleFlowCharacterDef,
  listGoogleFlowCharactersDef,
  deleteGoogleFlowCharacterDef,
  getGoogleFlowCharacterDef,
  replaceGoogleFlowCharacterDef,
} from "./google-flow-characters.js";
import { createCharacterDef } from "./create-character.js";
import { setCharacterMetadataDef } from "./set-character-metadata.js";
import { reorderCharacterImagesDef } from "./reorder-character-images.js";
import { uploadFileDef } from "./upload-file.js";
import { assetManifestDef } from "./asset-manifest.js";
import { deleteAssetDef } from "./delete-asset.js";
import { clearFailedTasksDef } from "./clear-failed-tasks.js";
import { recoverAssetDef } from "./recover-asset.js";
import { retryGenerationDef } from "./retry-generation.js";
import { doctorDef } from "./doctor.js";
import { renameAssetDef } from "./rename-asset.js";
import { renameAllDef } from "./rename-all.js";
import { markAssetSeenDef } from "./mark-asset-seen.js";
import { duplicateAssetDef } from "./duplicate-asset.js";
import { exportAssetDef } from "./export-asset.js";
import { assetHistoryDef } from "./asset-history.js";
import { restoreAssetVersionDef } from "./restore-asset-version.js";
import { readFileAtCommitDef } from "./read-file-at-commit.js";
import { readAssetMetadataDef } from "./read-asset-metadata.js";
import { trimVideoDef } from "./trim-video.js";
import { trimAudioDef } from "./trim-audio.js";
import { splitVideoDef } from "./split-video.js";
import { splitVideoByDurationsDef } from "./even-split.js";
import { padVideoDef } from "./pad-video.js";
import { cropVideoDef } from "./crop-video.js";
import { cropImageDef } from "./crop-image.js";
import { invertImageDef } from "./invert-image.js";
import { setVideoOverlayDef } from "./set-osg.js";
import { animateKeywordsDef } from "./animate-keywords.js";
import { downloadVideoDef } from "./download-video.js";
import { archiveClipDef } from "./archive-clip.js";
import { searchArchiveDef } from "./search-archive.js";
import { restoreArchiveClipsDef } from "./restore-archive-clips.js";
import { changeVideoSpeedDef } from "./change-video-speed.js";
import { timewarpVideoDef } from "./timewarp-video.js";
import { syncVideoToAudioDef } from "./sync-video-to-audio.js";
import { audioBoostDef } from "./audio-boost.js";
import { audioMixDef } from "./audio-mix.js";
import { reverseVideoDef } from "./reverse-video.js";
import { injectFirstFrameDef } from "./inject-first-frame.js";
import { extractFrameDefs } from "./extract-frame.js";
import { extractAudioDef } from "./extract-audio.js";
import { extendAudioDef } from "./extend-audio.js";
import { removeSoundDef } from "./remove-sound.js";
import { verifyXMentionsDef } from "./verify-x-mentions.js";
import { replaceVideoAudioDef } from "./replace-video-audio.js";
import { spliceVideoDef } from "./splice-video.js";
import { smoothSceneConcatDef } from "./smooth-scene-concat.js";
import { transcribeDef } from "./transcribe.js";
import { readTranscriptDef } from "./read-transcript.js";
import { translateSubtitlesDef } from "./translate-subtitles.js";
import { generateGrokImagineVideoDef } from "./generate-grok-imagine-video.js";
import { generateGrokImagineRefVideoDef } from "./generate-grok-imagine-ref-video.js";
import { generateGrokImagineT2vVideoDef } from "./generate-grok-imagine-t2v-video.js";
import { extendGrokImagineVideoDef } from "./extend-grok-imagine-video.js";
import { upscaleGrokImagineVideoDef } from "./upscale-grok-imagine-video.js";
import { generateKling30VideoDef } from "./generate-kling30-video.js";
import { generateKling30MotionControlVideoDef } from "./generate-kling30-motion-control-video.js";
import { generateSeedance2VideoDef } from "./generate-seedance2-video.js";
import { generateSeedance2FastVideoDef } from "./generate-seedance2-fast-video.js";
import { generateSeedance2MiniVideoDef } from "./generate-seedance2-mini-video.js";
import { generateGeminiOmniVideoDef } from "./generate-gemini-omni-video.js";
import { generateGoogleOmniVideoDef } from "./generate-google-omni-video.js";
import { generateVeo3VideoDef, generateVeo3FastVideoDef } from "./generate-veo3-video.js";
import {
  generateVeo31VideoDef,
  generateVeo31FastVideoDef,
  generateVeo31LiteVideoDef,
  generateVeo31LiteLowPriorityVideoDef,
} from "./generate-veo31-video.js";
import { generateNanoBananaProGoogleDef } from "./generate-nano-banana-pro-google.js";
import { generateKling30TurboVideoDef } from "./generate-kling30-turbo-video.js";
import { generateWan27T2vVideoDef } from "./generate-wan27-t2v-video.js";
import { generateWan27I2vVideoDef } from "./generate-wan27-i2v-video.js";
import { generateWan27VideoeditVideoDef } from "./generate-wan27-videoedit-video.js";
import { generateWan27R2vVideoDef } from "./generate-wan27-r2v-video.js";
import { extendWan27VideoDef } from "./extend-wan27-video.js";
import { generateHappyhorseT2vVideoDef } from "./generate-happyhorse-t2v-video.js";
import { generateHappyhorseI2vVideoDef } from "./generate-happyhorse-i2v-video.js";
import { generateHappyhorseRefVideoDef } from "./generate-happyhorse-ref-video.js";
import { generateHappyhorseVideoeditVideoDef } from "./generate-happyhorse-videoedit-video.js";
import { generateVolcengineLipsyncVideoDef } from "./generate-volcengine-lipsync-video.js";
import { generateOmnihumanVideoDef } from "./generate-omnihuman-video.js";
import { generateWan27ImageDef } from "./generate-wan27-image.js";
import { generateWan27ImageProDef } from "./generate-wan27-image-pro.js";
import { generateNanoBananaImageDef } from "./generate-nano-banana-image.js";
import { generateQwen2ImageEditDef } from "./generate-qwen2-image-edit.js";
import { generateSeedreamTextImageDef } from "./generate-seedream-text-image.js";
import { generateSeedreamImageDef } from "./generate-seedream-image.js";
import { renderVideoDef } from "./render.js";
import { syncDef } from "./sync.js";
import { listAssetsDef } from "./list-assets.js";
import { sleepDef } from "./sleep.js";
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
import { concatImagesDef } from "./concat-images.js";
import { chatDef } from "./chat.js";
import { getTimelineDef } from "./get-timeline.js";
import { setTimelineDef } from "./edit-timeline.js";
import { renderTimelineDef } from "./render-timeline.js";
import { showFolderDef } from "./show-folder.js";
import { copyFileToClipboardDef } from "./copy-file-to-clipboard.js";
import { exportToDownloadsDef } from "./export-to-downloads.js";
import { pushChatHistoryDef, listChatHistoryDef } from "./chat-history.js";
import { recordPromptDef, listPromptHistoryDef } from "./prompt-history.js";
import { rewritePromptDef } from "./rewrite-prompt.js";
import { describeImageDef } from "./describe-image.js";
import { rewriteScriptDef } from "./rewrite-script.js";
import { isolateVocalsDef } from "./isolate-vocals.js";
import { cleanVideoAudioDef } from "./clean-video-audio.js";
import { assignSlotDef } from "./assign-slot.js";
import { clearSlotDef } from "./clear-slot.js";
import { insertTimelineSlotDef } from "./insert-timeline-slot.js";
import { removeTimelineSlotDef } from "./remove-timeline-slot.js";
import { addTimelineAudioDef } from "./add-timeline-audio.js";
import { removeTimelineAudioDef } from "./remove-timeline-audio.js";
import { moveTimelineAudioDef } from "./move-timeline-audio.js";
import { updateTimelineAudioDef } from "./update-timeline-audio.js";
import { commandsDef } from "./commands.js";
import { getRenderSettingsDef } from "./render-settings.js";
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
import { generateNanoBanana2LiteFalDef } from "./generate-nano-banana-2-lite-fal.js";
import { generateNanoBanana2LiteEditFalDef } from "./generate-nano-banana-2-lite-edit-fal.js";
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

import { detectScenesDef } from "./detect-scenes.js";
import { suggestCutsDef } from "./suggest-cuts.js";
import { suggestSfxDef } from "./suggest-sfx.js";
import { analyzeJokesDef } from "./analyze-jokes.js";
import { applyCutsDef } from "./apply-cuts.js";
import { applySfxDef } from "./apply-sfx.js";

import { generateElevenlabsT2aDef } from "./generate-elevenlabs-t2a.js";
import { estimateCostDef } from "./estimate-cost.js";
import { postDef } from "./post.js";
import { xConnectStartDef, xConnectStatusDef } from "./connect-x.js";
import { createWatermarkCardDef } from "./create-watermark.js";
import { createQrOutroDef } from "./create-qr-outro.js";
import { createQartDef } from "./create-qart.js";
import { createQrbtfDef } from "./create-qrbtf.js";
import { getWatermarkConfigDef } from "./get-watermark-config.js";
import { withLogging } from "./log-wrapper.js";

export function getVideoEditingToolDefs(fs: Engine): ToolDef[] {
  return [
    trimVideoDef(fs),
    trimAudioDef(fs),
    splitVideoDef(fs),
    splitVideoByDurationsDef(fs),
    padVideoDef(fs),
    cropVideoDef(fs),
    cropImageDef(fs),
    invertImageDef(fs),
    setVideoOverlayDef(fs),
    animateKeywordsDef(fs),
    detectScenesDef(fs),
    suggestCutsDef(fs),
    suggestSfxDef(fs),
    analyzeJokesDef(fs),
    applyCutsDef(fs),
    applySfxDef(fs),
    changeVideoSpeedDef(fs),
    timewarpVideoDef(fs),
    syncVideoToAudioDef(fs),
    audioBoostDef(fs),
    audioMixDef(fs),
    reverseVideoDef(fs),
    injectFirstFrameDef(fs),
    ...extractFrameDefs(fs),
    extractAudioDef(fs),
    extendAudioDef(fs),
    removeSoundDef(fs),
    replaceVideoAudioDef(fs),
    spliceVideoDef(fs),
    smoothSceneConcatDef(fs),
    transcribeDef(fs),
    readTranscriptDef(fs),
    translateSubtitlesDef(fs),
    isolateVocalsDef(fs),
    cleanVideoAudioDef(fs),
    renderVideoDef(fs),
    getTimelineDef(fs),
    setTimelineDef(fs),
    renderTimelineDef(fs),
    assignSlotDef(fs),
    clearSlotDef(fs),
    insertTimelineSlotDef(fs),
    removeTimelineSlotDef(fs),
    addTimelineAudioDef(fs),
    removeTimelineAudioDef(fs),
    moveTimelineAudioDef(fs),
    updateTimelineAudioDef(fs),
    getRenderSettingsDef(fs),
    createWatermarkCardDef(fs),
  ];
}

function scopeTool(def: ToolDef, books: BookManager): ToolDef {
  const scope = def.scope ?? ("book_id" in def.schema ? "book" : "global");
  if (scope === "global") return def;
  return {
    ...def,
    scope,
    handler: async (args) => {
      const bookId = args.book_id;
      if (typeof bookId !== "string") {
        return {
          isError: true,
          content: [{ type: "text", text: "book_id is required" }],
        };
      }
      await books.ready();
      const book = books.get(bookId);
      if (!book.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: book.error.message }],
        };
      }
      return withBookContext(
        { bookId, engine: book.value.engine },
        () => def.handler(args),
      );
    },
  };
}

export function registerAllTools(
  server: McpServer,
  fs: Engine,
  books: BookManager = bookManager,
): void {
  const defs = getAllToolDefs(fs, books)
    .map((def) => withLogging(def, fs))
    .map((def) => scopeTool(def, books));
  for (const def of defs) {
    server.tool(def.name, def.description, def.schema, def.handler);
  }
}

export function getAllToolDefs(
  fs: Engine,
  books: BookManager = bookManager,
): ToolDef[] {
  const rawDefs: ToolDef[] = [
    apiStatusDef(),
    providerKeyStatusDef(),
    setEnvSecretDef(),
    listElevenLabsVoicesDef(),
    createGoogleFlowVoiceDef(),
    listGoogleFlowVoicesDef(),
    deleteGoogleFlowVoiceDef(),
    createGoogleFlowCharacterDef(fs),
    getGoogleFlowCharacterDef(),
    replaceGoogleFlowCharacterDef(fs),
    listGoogleFlowCharactersDef(),
    deleteGoogleFlowCharacterDef(),
    estimateCostDef(fs),
    createCharacterDef(fs),
    setCharacterMetadataDef(fs),
    reorderCharacterImagesDef(fs),
    uploadFileDef(fs),
    assetManifestDef(fs),
    deleteAssetDef(fs),
    clearFailedTasksDef(fs),
    recoverAssetDef(fs),
    retryGenerationDef(fs),
    doctorDef(fs),
    renameAssetDef(fs),
    renameAllDef(fs),
    markAssetSeenDef(fs),
    duplicateAssetDef(fs),
    exportAssetDef(fs),
    assetHistoryDef(fs),
    restoreAssetVersionDef(fs),
    readFileAtCommitDef(fs),
    readAssetMetadataDef(fs),
    ...getVideoEditingToolDefs(fs),
    downloadVideoDef(fs),
    archiveClipDef(fs),
    searchArchiveDef(),
    restoreArchiveClipsDef(fs),
    verifyXMentionsDef(),
    generateGrokImagineVideoDef(fs),
    generateGrokImagineRefVideoDef(fs),
    generateGrokImagineT2vVideoDef(fs),
    extendGrokImagineVideoDef(fs),
    upscaleGrokImagineVideoDef(fs),
    generateKling30VideoDef(fs),
    generateKling30MotionControlVideoDef(fs),
    generateSeedance2VideoDef(fs),
    generateSeedance2FastVideoDef(fs),
    generateSeedance2MiniVideoDef(fs),
    generateGeminiOmniVideoDef(fs),
    generateGoogleOmniVideoDef(fs),
    generateVeo3VideoDef(fs),
    generateVeo3FastVideoDef(fs),
    generateVeo31VideoDef(fs),
    generateVeo31FastVideoDef(fs),
    generateVeo31LiteVideoDef(fs),
    generateVeo31LiteLowPriorityVideoDef(fs),
    generateNanoBananaProGoogleDef(fs),
    generateKling30TurboVideoDef(fs),
    generateWan27T2vVideoDef(fs),
    generateWan27I2vVideoDef(fs),
    generateWan27VideoeditVideoDef(fs),
    generateWan27R2vVideoDef(fs),
    extendWan27VideoDef(fs),
    generateHappyhorseT2vVideoDef(fs),
    generateHappyhorseI2vVideoDef(fs),
    generateHappyhorseRefVideoDef(fs),
    generateHappyhorseVideoeditVideoDef(fs),
    generateVolcengineLipsyncVideoDef(fs),
    generateOmnihumanVideoDef(fs),
    generateWan27ImageDef(fs),
    generateWan27ImageProDef(fs),
    generateNanoBananaImageDef(fs),
    generateQwen2ImageEditDef(fs),
    generateSeedreamTextImageDef(fs),
    generateSeedreamImageDef(fs),
    syncDef(fs),
    listAssetsDef(fs),
    sleepDef(fs),
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
    concatImagesDef(fs),
    chatDef(fs),
    showFolderDef(fs),
    copyFileToClipboardDef(fs),
    exportToDownloadsDef(fs),
    pushChatHistoryDef(fs),
    listChatHistoryDef(fs),
    recordPromptDef(fs),
    listPromptHistoryDef(fs),
    rewritePromptDef(fs),
    describeImageDef(fs),
    rewriteScriptDef(fs),
    commandsDef(),
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
    generateNanoBanana2LiteFalDef(fs),
    generateNanoBanana2LiteEditFalDef(fs),
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

    generateElevenlabsT2aDef(fs),
    postDef(),
    xConnectStartDef(),
    xConnectStatusDef(),
    createQrOutroDef(fs),
    createQartDef(fs),
    createQrbtfDef(fs),
    getWatermarkConfigDef(fs),
    ...commandPlanDefs(fs),
    ...exportSequenceDefs(fs),
    ...semanticSearchDefs(fs, books),
    ...videobookDomainDefs(fs, books),
  ];

  return rawDefs;
}
