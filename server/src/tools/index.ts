import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Engine } from "videobook-engine";
import type { BookManager } from "../book-manager.js";
import { withBookContext } from "../book-context.js";
import { bookManager } from "../engine.js";
import type { ToolDef } from "./tool-def.js";
import { videobookDomainDefs } from "./videobook-domain.js";
import { semanticSearchDefs } from "./semantic-search.js";
import { commandPlanDefs } from "./command-plan.js";
import { exportSequenceDefs } from "./export-sequence.js";
import { apiStatusDef } from "./api-status.js";
import { providerKeyStatusDef } from "./provider-key-status.js";
import { setEnvSecretDef } from "./set-env-secret.js";
import { mediaLibraryDefs } from "./media-library.js";
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
import { extractVideoClipDef } from "./extract-video-clip.js";
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
import { extractNotebookFrameDef } from "./extract-notebook-frame.js";
import { extractNotebookAudioDef } from "./extract-notebook-audio.js";
import { extractAudioDef } from "./extract-audio.js";
import { makeCoverSongDef } from "./make-cover-song.js";
import { extendAudioDef } from "./extend-audio.js";
import { removeSoundDef } from "./remove-sound.js";
import { verifyXMentionsDef } from "./verify-x-mentions.js";
import { replaceVideoAudioDef } from "./replace-video-audio.js";
import { spliceVideoDef } from "./splice-video.js";
import { smoothSceneConcatDef } from "./smooth-scene-concat.js";
import { transcribeDef } from "./transcribe.js";
import { readTranscriptDef } from "./read-transcript.js";
import { analyzeVideoDef } from "./analyze-video.js";
import { translateSubtitlesDef } from "./translate-subtitles.js";
import { generateGrokImagineVideoDef } from "./generate-grok-imagine-video.js";
import { generateGrokImagineRefVideoDef } from "./generate-grok-imagine-ref-video.js";
import { generateGrokImagineT2vVideoDef } from "./generate-grok-imagine-t2v-video.js";
import { extendGrokImagineVideoDef } from "./extend-grok-imagine-video.js";
import { upscaleGrokImagineVideoDef } from "./upscale-grok-imagine-video.js";
import { generateKling30MotionControlVideoDef } from "./generate-kling30-motion-control-video.js";
import {
  generateKlingOmniImageToVideoDef,
  generateKlingOmniReferenceToVideoDef,
  generateKlingOmniTextToVideoDef,
  generateKlingOmniTransformationDef,
} from "./generate-kling30-omni-video.js";
import { generateSeedance25VideoDef } from "./generate-seedance25-video.js";
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

import { generateHappyhorseT2vVideoDef } from "./generate-happyhorse-t2v-video.js";
import { generateHappyhorseI2vVideoDef } from "./generate-happyhorse-i2v-video.js";
import { generateHappyhorseRefVideoDef } from "./generate-happyhorse-ref-video.js";
import { generateHappyhorseVideoeditVideoDef } from "./generate-happyhorse-videoedit-video.js";
import { generateMiniMaxH3T2vVideoDef } from "./generate-minimax-h3-t2v-video.js";
import { generateMiniMaxH3I2vVideoDef } from "./generate-minimax-h3-i2v-video.js";
import { generateMiniMaxH3R2vVideoDef } from "./generate-minimax-h3-r2v-video.js";
import { generateVolcengineLipsyncVideoDef } from "./generate-volcengine-lipsync-video.js";
import { generateOmnihumanVideoDef } from "./generate-omnihuman-video.js";
import { generateNanoBananaImageDef } from "./generate-nano-banana-image.js";
import { generateQwen2ImageEditDef } from "./generate-qwen2-image-edit.js";
import { generateQwen3ImageEditDef } from "./generate-qwen3-image-edit.js";
import { generateSeedreamTextImageDef } from "./generate-seedream-text-image.js";
import { generateSeedreamImageDef } from "./generate-seedream-image.js";
import { renderVideoDef } from "./render.js";
import { reconcileProjectWorkDef } from "./reconcile-project-work.js";
import { assetTagDefs } from "./asset-tags.js";
import { listAssetsDef } from "./list-assets.js";
import { listCellGenerationsDef } from "./list-cell-generations.js";
import { waitForAssetReadyDef } from "./wait-for-asset-ready.js";
import { previewVideoGenDef } from "./preview-video-gen.js";
import { previewImageGenDef } from "./preview-image-gen.js";
import { generationPayloadDef } from "./generation-payload.js";
import { generateGrokImagineImageDef } from "./generate-grok-imagine-image.js";
import { generateGrokImagineTextImageDef } from "./generate-grok-imagine-text-image.js";
import { generateGptImageDef } from "./generate-gpt-image.js";
import { generateGptImageTextDef } from "./generate-gpt-image-text.js";
import { generateAlibabaQwenImageDef } from "./generate-alibaba-qwen-image.js";
import { generateAlibabaQwenImageEditDef } from "./generate-alibaba-qwen-image-edit.js";
import { concatImagesDef } from "./concat-images.js";
import { chatDef } from "./chat.js";
import { chainDef } from "./chain.js";
import { getTimelineDef } from "./get-timeline.js";
import { setTimelineDef } from "./edit-timeline.js";
import { renderTimelineDef } from "./render-timeline.js";
import { showFolderDef } from "./show-folder.js";
import { copyFileToClipboardDef } from "./copy-file-to-clipboard.js";
import { exportToDownloadsDef } from "./export-to-downloads.js";
import { exportTranscriptSrtDef } from "./export-transcript-srt.js";
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

import { generateNanoBananaProFalDef } from "./generate-nano-banana-pro-fal.js";
import { generateNanoBananaProEditFalDef } from "./generate-nano-banana-pro-edit-fal.js";
import { generateSeedreamV5LiteFalDef } from "./generate-seedream-v5-lite-fal.js";
import { generateSeedreamV5LiteEditFalDef } from "./generate-seedream-v5-lite-edit-fal.js";
import { generateGrokImagineImageFalDef } from "./generate-grok-imagine-image-fal.js";
import { generateGrokImagineImageEditFalDef } from "./generate-grok-imagine-image-edit-fal.js";

import { generateGrokImagineVideoI2vFalDef } from "./generate-grok-imagine-video-i2v-fal.js";
import { generateNanoBananaFalDef } from "./generate-nano-banana-fal.js";
import { generateNanoBananaEditFalDef } from "./generate-nano-banana-edit-fal.js";
import { generateNanoBanana2FalDef } from "./generate-nano-banana-2-fal.js";
import { generateNanoBanana2EditFalDef } from "./generate-nano-banana-2-edit-fal.js";
import { generateNanoBanana2LiteFalDef } from "./generate-nano-banana-2-lite-fal.js";
import { generateNanoBanana2LiteEditFalDef } from "./generate-nano-banana-2-lite-edit-fal.js";
import { generateQwenImageFalDef } from "./generate-qwen-image-fal.js";
import { generateQwenImageEditFalDef } from "./generate-qwen-image-edit-fal.js";
import { generateQwen3ImageEditFalDef } from "./generate-qwen3-image-edit-fal.js";

import { generateGrokImagineVideoR2vFalDef } from "./generate-grok-imagine-video-r2v-fal.js";
import { generateGrokImagineVideoExtendFalDef } from "./generate-grok-imagine-video-extend-fal.js";
import { generateGrokImagineVideoEditFalDef } from "./generate-grok-imagine-video-edit-fal.js";
import { generateWan30T2vFalDef } from "./generate-wan30-t2v-fal.js";
import { generateWan30I2vFalDef } from "./generate-wan30-i2v-fal.js";
import { generateWan30R2vFalDef } from "./generate-wan30-r2v-fal.js";
import { generateWan30PrimeT2vFalDef } from "./generate-wan30-prime-t2v-fal.js";
import { generateWan30PrimeI2vFalDef } from "./generate-wan30-prime-i2v-fal.js";
import { generateWan30PrimeR2vFalDef } from "./generate-wan30-prime-r2v-fal.js";
import {
  generateKieWan30PrimeVideoDef,
  generateKieWan30VideoDef,
} from "./generate-wan30-video.js";
import { genImagesAllDef } from "./gen-images-all.js";
import { imageSubjectDefs } from "./image-subjects.js";

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
import { applyWatermarkDef } from "./apply-watermark.js";
import { createQrOutroDef } from "./create-qr-outro.js";
import { createQartDef } from "./create-qart.js";
import { createQrbtfDef } from "./create-qrbtf.js";
import { getWatermarkConfigDef } from "./get-watermark-config.js";
import { withLogging } from "./log-wrapper.js";
import { listChatModelsDef } from "../chat-models.js";

export function getVideoEditingToolDefs(engine: Engine): ToolDef[] {
  return [
    trimVideoDef(engine),
    trimAudioDef(engine),
    splitVideoDef(engine),
    extractVideoClipDef(engine),
    splitVideoByDurationsDef(engine),
    padVideoDef(engine),
    cropVideoDef(engine),
    cropImageDef(engine),
    invertImageDef(engine),
    setVideoOverlayDef(engine),
    animateKeywordsDef(engine),
    detectScenesDef(engine),
    suggestCutsDef(engine),
    suggestSfxDef(engine),
    analyzeJokesDef(engine),
    applyCutsDef(engine),
    applySfxDef(engine),
    changeVideoSpeedDef(engine),
    timewarpVideoDef(engine),
    syncVideoToAudioDef(engine),
    audioBoostDef(engine),
    audioMixDef(engine),
    reverseVideoDef(engine),
    injectFirstFrameDef(engine),
    ...extractFrameDefs(engine),
    extractNotebookFrameDef(engine),
    extractNotebookAudioDef(engine),
    extractAudioDef(engine),
    makeCoverSongDef(engine),
    extendAudioDef(engine),
    removeSoundDef(engine),
    replaceVideoAudioDef(engine),
    spliceVideoDef(engine),
    smoothSceneConcatDef(engine),
    transcribeDef(engine),
    readTranscriptDef(engine),
    analyzeVideoDef(engine),
    translateSubtitlesDef(engine),
    isolateVocalsDef(engine),
    cleanVideoAudioDef(engine),
    renderVideoDef(engine),
    getTimelineDef(engine),
    setTimelineDef(engine),
    renderTimelineDef(engine),
    assignSlotDef(engine),
    clearSlotDef(engine),
    insertTimelineSlotDef(engine),
    removeTimelineSlotDef(engine),
    addTimelineAudioDef(engine),
    removeTimelineAudioDef(engine),
    moveTimelineAudioDef(engine),
    updateTimelineAudioDef(engine),
    getRenderSettingsDef(engine),
    createWatermarkCardDef(engine),
    applyWatermarkDef(engine),
  ];
}

function scopeTool(
  def: ToolDef,
  books: BookManager,
  injectedEngine: Engine,
): ToolDef {
  const scope = def.scope ?? ("book_id" in def.schema ? "book" : "global");
  if (scope === "global") return def;
  let injectedBookId: string | null = null;
  try {
    injectedBookId = injectedEngine.book.get().bookId;
  } catch {
    injectedBookId = null;
  }
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
      if (bookId === injectedBookId) {
        return withBookContext(
          { bookId, engine: injectedEngine },
          () => def.handler(args),
        );
      }
      const book = await books.ensure(bookId);
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
  engine: Engine,
  books: BookManager = bookManager,
): void {
  const defs = getAllToolDefs(engine, books)
    .map((def) => withLogging(def, engine))
    .map((def) => scopeTool(def, books, engine));
  for (const def of defs) {
    server.registerTool(def.name, {
      description: def.description,
      inputSchema: z.object(def.schema),
      ...(def.annotations ? { annotations: def.annotations } : {}),
    }, def.handler);
  }
}

export function getAllToolDefs(
  engine: Engine,
  books: BookManager = bookManager,
): ToolDef[] {
  const rawDefs: ToolDef[] = [
    apiStatusDef(),
    listChatModelsDef(),
    providerKeyStatusDef(),
    setEnvSecretDef(),
    listElevenLabsVoicesDef(),
    createGoogleFlowVoiceDef(),
    listGoogleFlowVoicesDef(),
    deleteGoogleFlowVoiceDef(),
    createGoogleFlowCharacterDef(engine),
    getGoogleFlowCharacterDef(),
    replaceGoogleFlowCharacterDef(engine),
    listGoogleFlowCharactersDef(),
    deleteGoogleFlowCharacterDef(),
    estimateCostDef(engine),
    createCharacterDef(engine),
    setCharacterMetadataDef(engine),
    reorderCharacterImagesDef(engine),
    uploadFileDef(engine),
    assetManifestDef(engine),
    deleteAssetDef(engine),
    clearFailedTasksDef(engine),
    recoverAssetDef(engine),
    retryGenerationDef(engine),
    doctorDef(engine),
    renameAssetDef(engine),
    renameAllDef(engine),
    markAssetSeenDef(engine),
    duplicateAssetDef(engine),
    exportAssetDef(engine, books),
    assetHistoryDef(engine),
    restoreAssetVersionDef(engine),
    readFileAtCommitDef(engine),
    readAssetMetadataDef(engine),
    ...getVideoEditingToolDefs(engine),
    downloadVideoDef(engine),
    archiveClipDef(engine),
    searchArchiveDef(),
    restoreArchiveClipsDef(engine),
    verifyXMentionsDef(),
    generateGrokImagineVideoDef(engine),
    generateGrokImagineRefVideoDef(engine),
    generateGrokImagineT2vVideoDef(engine),
    extendGrokImagineVideoDef(engine),
    upscaleGrokImagineVideoDef(engine),
    generateKlingOmniTextToVideoDef(engine),
    generateKlingOmniImageToVideoDef(engine),
    generateKlingOmniReferenceToVideoDef(engine),
    generateKlingOmniTransformationDef(engine),
    generateKling30MotionControlVideoDef(engine),
    generateSeedance25VideoDef(engine),
    generateGeminiOmniVideoDef(engine),
    generateGoogleOmniVideoDef(engine),
    generateVeo3VideoDef(engine),
    generateVeo3FastVideoDef(engine),
    generateVeo31VideoDef(engine),
    generateVeo31FastVideoDef(engine),
    generateVeo31LiteVideoDef(engine),
    generateVeo31LiteLowPriorityVideoDef(engine),
    generateNanoBananaProGoogleDef(engine),

    generateHappyhorseT2vVideoDef(engine),
    generateHappyhorseI2vVideoDef(engine),
    generateHappyhorseRefVideoDef(engine),
    generateHappyhorseVideoeditVideoDef(engine),
    generateMiniMaxH3T2vVideoDef(engine),
    generateMiniMaxH3I2vVideoDef(engine),
    generateMiniMaxH3R2vVideoDef(engine),
    generateVolcengineLipsyncVideoDef(engine),
    generateOmnihumanVideoDef(engine),
    generateNanoBananaImageDef(engine),
    generateQwen2ImageEditDef(engine),
    generateQwen3ImageEditDef(engine),
    generateSeedreamTextImageDef(engine),
    generateSeedreamImageDef(engine),
    reconcileProjectWorkDef(engine),
    listAssetsDef(engine),
    ...assetTagDefs(engine),
    listCellGenerationsDef(engine),
    waitForAssetReadyDef(engine),
    previewVideoGenDef(engine),
    previewImageGenDef(engine),
    generationPayloadDef(engine),
    generateGrokImagineImageDef(engine),
    generateGrokImagineTextImageDef(engine),
    generateGptImageDef(engine),
    generateGptImageTextDef(engine),
    generateAlibabaQwenImageDef(engine),
    generateAlibabaQwenImageEditDef(engine),
    concatImagesDef(engine),
    chatDef(engine),
    chainDef(engine),
    showFolderDef(engine),
    copyFileToClipboardDef(engine),
    exportToDownloadsDef(engine),
    exportTranscriptSrtDef(engine),
    pushChatHistoryDef(engine),
    listChatHistoryDef(engine),
    recordPromptDef(engine),
    listPromptHistoryDef(engine),
    rewritePromptDef(engine),
    describeImageDef(engine),
    rewriteScriptDef(engine),
    commandsDef(books),
    translatePayloadDef(),
    updateScriptDef(engine),

    generateNanoBananaProFalDef(engine),
    generateNanoBananaProEditFalDef(engine),
    generateSeedreamV5LiteFalDef(engine),
    generateSeedreamV5LiteEditFalDef(engine),
    generateGrokImagineImageFalDef(engine),
    generateGrokImagineImageEditFalDef(engine),

    generateGrokImagineVideoI2vFalDef(engine),
    generateNanoBananaFalDef(engine),
    generateNanoBananaEditFalDef(engine),
    generateNanoBanana2FalDef(engine),
    generateNanoBanana2EditFalDef(engine),
    generateNanoBanana2LiteFalDef(engine),
    generateNanoBanana2LiteEditFalDef(engine),
    generateQwenImageFalDef(engine),
    generateQwenImageEditFalDef(engine),
    generateQwen3ImageEditFalDef(engine),

    generateGrokImagineVideoR2vFalDef(engine),
    generateGrokImagineVideoExtendFalDef(engine),
    generateGrokImagineVideoEditFalDef(engine),
    generateWan30T2vFalDef(engine),
    generateWan30I2vFalDef(engine),
    generateWan30R2vFalDef(engine),
    generateWan30PrimeT2vFalDef(engine),
    generateWan30PrimeI2vFalDef(engine),
    generateWan30PrimeR2vFalDef(engine),
    generateKieWan30VideoDef(engine),
    generateKieWan30PrimeVideoDef(engine),
    genImagesAllDef(engine),
    ...imageSubjectDefs(engine),

    generateElevenlabsT2aDef(engine),
    postDef(),
    xConnectStartDef(),
    xConnectStatusDef(),
    createQrOutroDef(engine),
    createQartDef(engine),
    createQrbtfDef(engine),
    getWatermarkConfigDef(engine),
    ...commandPlanDefs(engine),
    ...exportSequenceDefs(engine),
    ...semanticSearchDefs(engine, books),
    ...mediaLibraryDefs(books),
    ...videobookDomainDefs(engine, books),
  ];

  return rawDefs;
}
