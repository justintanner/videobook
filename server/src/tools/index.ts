import { setHarCaptureDef } from "./set-har-capture.js";
import { coldOpenDefs } from "./cold-open.js";
import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { Engine } from "videobook-engine";
import type { BookManager } from "../book-manager.js";
import { withBookContext } from "../book-context.js";
import { bookManager } from "../engine.js";
import type { ToolDef } from "./tool-def.js";
import { videobookDomainDefs } from "./videobook-domain.js";
import { semanticSearchDefs } from "./semantic-search.js";
import { commandPlanDefs } from "./command-plan.js";
import { musicDraftDefs } from "./music-draft.js";
import { musicAnalysisDefs } from "./music-analysis.js";
import { editingMomentsDefs } from "./editing-moments.js";
import { sequenceRhythmDefs } from "./sequence-rhythm.js";
import { exportSequenceDefs } from "./export-sequence.js";
import { apiStatusDef } from "./api-status.js";
import { providerKeyStatusDef } from "./provider-key-status.js";
import { setEnvSecretDef } from "./set-env-secret.js";
import { mediaLibraryDefs } from "./media-library.js";
import { listElevenLabsVoicesDef } from "./list-elevenlabs-voices.js";
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
import { cropAssetDef } from "./crop-asset.js";
import { invertImageDef } from "./invert-image.js";
import { setVideoOverlayDef } from "./set-osg.js";
import { animateKeywordsDef } from "./animate-keywords.js";
import { aliveCaptionsDef, setAliveCaptionsDef } from "./alive-captions.js";
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
import { extractFrameDef } from "./extract-frame.js";
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

import { renderVideoDef } from "./render.js";
import { reconcileProjectWorkDef } from "./reconcile-project-work.js";
import { assetTagDefs } from "./asset-tags.js";
import { tagBackfillDefs } from "./tag-backfill.js";
import { listAssetsDef } from "./list-assets.js";
import { listCellGenerationsDef } from "./list-cell-generations.js";
import { waitForAssetReadyDef } from "./wait-for-asset-ready.js";
import { generationPayloadDef } from "./generation-payload.js";
import { concatImagesDef } from "./concat-images.js";
import { chatDef } from "./chat.js";
import { chainDef } from "./chain.js";
import { goalDefs } from "./goal.js";
import { getTimelineDef } from "./get-timeline.js";
import { setTimelineDef } from "./edit-timeline.js";
import { renderTimelineDef } from "./render-timeline.js";
import { exportAssetFileDef } from "./export-asset-file.js";
import { exportTranscriptSrtDef } from "./export-transcript-srt.js";
import { recordPromptDef, listPromptHistoryDef } from "./prompt-history.js";
import { rewritePromptDef } from "./rewrite-prompt.js";
import { describeImageDef } from "./describe-image.js";
import { rewriteScriptDef } from "./rewrite-script.js";
import { isolateVocalsDef } from "./isolate-vocals.js";
import { cleanVideoAudioDef } from "./clean-video-audio.js";
import { assignSlotDef } from "./assign-slot.js";
import { removeTimelineSlotDef } from "./remove-timeline-slot.js";
import { addTimelineAudioDef } from "./add-timeline-audio.js";
import { removeTimelineAudioDef } from "./remove-timeline-audio.js";
import { moveTimelineAudioDef } from "./move-timeline-audio.js";
import { updateTimelineAudioDef } from "./update-timeline-audio.js";
import { commandsDef, getCanonicalCommands } from "./commands.js";
import { buildWorkspaceActionCatalog } from "../workspace-action-catalog.js";
import { workspaceActionsDef } from "./workspace-actions.js";
import { getRenderSettingsDef } from "./render-settings.js";
import { updateScriptDef } from "./update-script.js";



import { imageSubjectDefs } from "./image-subjects.js";

import { detectScenesDef } from "./detect-scenes.js";
import { suggestCutsDef } from "./suggest-cuts.js";
import { suggestSfxDef } from "./suggest-sfx.js";
import { analyzeJokesDef } from "./analyze-jokes.js";
import { applyCutsDef } from "./apply-cuts.js";
import { applySfxDef } from "./apply-sfx.js";

import { generateMediaDefs } from "./generate-media.js";
import { estimateCostDef } from "./estimate-cost.js";
import { bookUsageDef } from "./book-usage.js";
import { postRecordDefs } from "./post-record.js";
import { postDef } from "./post.js";
import { connectServiceDef, serviceStatusDef } from "./connect-service.js";
import { createWatermarkCardDef } from "./create-watermark.js";
import { applyWatermarkDef } from "./apply-watermark.js";
import { createQrOutroDef } from "./create-qr-outro.js";
import { createQartDef } from "./create-qart.js";
import { createQrbtfDef } from "./create-qrbtf.js";
import { getWatermarkConfigDef } from "./get-watermark-config.js";
import { withLogging } from "./log-wrapper.js";
import { toolInputSchema } from "./tool-json-schema.js";
import { listChatModelsDef } from "../chat-models.js";

export function getVideoEditingToolDefs(engine: Engine): ToolDef[] {
  return [
    ...coldOpenDefs(engine),
    trimVideoDef(engine),
    trimAudioDef(engine),
    splitVideoDef(engine),
    extractVideoClipDef(engine),
    splitVideoByDurationsDef(engine),
    padVideoDef(engine),
    cropAssetDef(engine),
    invertImageDef(engine),
    setVideoOverlayDef(engine),
    animateKeywordsDef(engine),
    aliveCaptionsDef(engine),
    setAliveCaptionsDef(engine),
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
    extractFrameDef(engine),
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

function injectedBookIdOf(engine: Engine): string | null {
  try {
    return engine.book.get().bookId;
  } catch {
    return null;
  }
}

function scopeTool(
  def: ToolDef,
  books: BookManager,
  injectedEngine: Engine,
): ToolDef {
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
      if (bookId === injectedBookIdOf(injectedEngine)) {
        return withBookContext(
          { bookId, engine: injectedEngine, operation: def.name },
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
        { bookId, engine: book.value.engine, operation: def.name },
        () => def.handler(args),
      );
    },
  };
}

type PreparedTool = {
  def: ToolDef;
  inputSchema: StandardSchemaWithJSON<Record<string, unknown>>;
};

const preparedTools = new WeakMap<Engine, WeakMap<BookManager, readonly PreparedTool[]>>();

function prepareTools(engine: Engine, books: BookManager): readonly PreparedTool[] {
  return getAllToolDefs(engine, books)
    .map((def) => scopeTool(withLogging(def, engine), books, engine))
    .map((def) => ({ def, inputSchema: toolInputSchema(def.schema) }));
}

export function preparedToolsFor(engine: Engine, books: BookManager): readonly PreparedTool[] {
  const byBooks = preparedTools.get(engine) ?? new WeakMap<BookManager, readonly PreparedTool[]>();
  preparedTools.set(engine, byBooks);
  const prepared = byBooks.get(books) ?? prepareTools(engine, books);
  byBooks.set(books, prepared);
  return prepared;
}

export function registerAllTools(
  server: McpServer,
  engine: Engine,
  books: BookManager = bookManager,
): void {
  for (const { def, inputSchema } of preparedToolsFor(engine, books)) {
    server.registerTool(def.name, {
      description: def.description,
      inputSchema,
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
    setHarCaptureDef(),
    listElevenLabsVoicesDef(),
    estimateCostDef(engine, books),
    bookUsageDef(engine),
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

    reconcileProjectWorkDef(engine),
    listAssetsDef(engine),
    ...assetTagDefs(engine),
    ...tagBackfillDefs(engine),
    listCellGenerationsDef(engine),
    waitForAssetReadyDef(engine),
    generationPayloadDef(engine),
    concatImagesDef(engine),
    chatDef(engine),
    chainDef(engine),
    ...goalDefs(engine),
    exportAssetFileDef(engine),
    exportTranscriptSrtDef(engine),
    recordPromptDef(engine),
    listPromptHistoryDef(engine),
    rewritePromptDef(engine),
    describeImageDef(engine),
    rewriteScriptDef(engine),
    commandsDef(books, () => buildWorkspaceActionCatalog(rawDefs, getCanonicalCommands()).actions.flatMap((action) => [action.command, ...action.aliases])),
    updateScriptDef(engine),



    ...imageSubjectDefs(engine),

    ...generateMediaDefs(engine),
    postDef(),
    ...postRecordDefs(engine),
    connectServiceDef(),
    serviceStatusDef(),
    createQrOutroDef(engine),
    createQartDef(engine),
    createQrbtfDef(engine),
    getWatermarkConfigDef(engine),
    ...commandPlanDefs(engine),
    ...exportSequenceDefs(engine),
    ...musicAnalysisDefs(engine),
    ...musicDraftDefs(engine),
    ...sequenceRhythmDefs(engine),
    ...editingMomentsDefs(engine),
    ...semanticSearchDefs(engine, books),
    ...mediaLibraryDefs(books),
    ...videobookDomainDefs(engine, books),
    workspaceActionsDef(() => rawDefs),
  ];

  return rawDefs;
}
