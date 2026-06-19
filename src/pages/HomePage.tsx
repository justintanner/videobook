import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Grid3x3 } from 'lucide-react';
import { CollapsibleSidebar } from '@/components/sidebar/CollapsibleSidebar';
import { SidebarHeader } from '@/components/sidebar/SidebarHeader';
import { UploadSlot } from '@/components/sidebar/UploadSlot';
import { ImageCard } from '@/components/sidebar/cards/ImageCard';
import { AudioCard } from '@/components/sidebar/cards/AudioCard';
import { ScriptCard } from '@/components/sidebar/cards/ScriptCard';
import { PlanCard } from '@/components/sidebar/cards/PlanCard';
import { VideoCard } from '@/components/sidebar/cards/VideoCard';
import { FinalVideoCard } from '@/components/sidebar/cards/FinalVideoCard';
import { GhostClipCard } from '@/components/sidebar/cards/GhostClipCard';
import { SidebarMicroThumb } from '@/components/sidebar/SidebarMicroThumb';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { AssetMenu, ProjectExportPicker } from '@/components/sidebar/menus/AssetMenu';
import { IdleScreen, AssetViewer, PlanViewer, TemplatesViewer, ArchiveBrowser } from '@/components/center-stage';
import type { ArchiveSearchResponse, RestoreResponse, ViewerSize } from '@/components/center-stage';
import { TimelinePlayer } from '@/components/timeline/TimelinePlayer';
import { useTimelinePreview } from '@/hooks/useTimelinePreview';
import { ChatInput } from '@/components/ui/ChatInput';
import type { ChatInputHandle } from '@/components/ui/ChatInput';
import { HomeHeaderBar } from '@/components/layout/HomeHeaderBar';
import { ProviderKeysScreen } from '@/components/settings/ProviderKeysScreen';
import { ActivityLogDrawer } from '@/components/commands';
import { useProjectActivity } from '@/hooks/useProjectActivity';
import { TrimEditor } from '@/components/commands/trim/TrimEditor';
import { GenPreviewPanel } from '@/components/gen/GenPreviewPanel';
import type { GenPreviewPanelHandle } from '@/components/gen/GenPreviewPanel';
import { CharacterDialog } from '@/components/character/CharacterDialog';
import { PostComposerDialog } from '@/components/post/PostComposerDialog';
import { useExtractSkeleton } from '@/hooks/useExtractSkeleton';
import { useGenerateCharacter } from '@/hooks/useGenerateCharacter';
import type { CharacterProfile } from '@/hooks/useCharacterSlots';
import { TimelineSlot } from '@/components/timeline/TimelineSlot';
import { TimelineAudioLane } from '@/components/timeline/TimelineAudioLane';
import { DropzoneOverlay } from '@/components/DropzoneOverlay';
import { useMcpConnection } from '@/hooks/useMcpConnection';
import { useUploadFile } from '@/hooks/useUploadFile';
import { useDefaultProject } from '@/hooks/useDefaultProject';
import { useWindowDropzone } from '@/hooks/useWindowDropzone';
import { useSync } from '@/hooks/useSync';
import { useSwitchProject } from '@/hooks/useSwitchProject';
import { useListAssets } from '@/hooks/useListAssets';
import { useListProjects } from '@/hooks/useListProjects';
import { useMarkAssetSeen } from '@/hooks/useMarkAssetSeen';
import { useCreateProject } from '@/hooks/useCreateProject';
import { useRenameProject } from '@/hooks/useRenameProject';
import { useDeleteProject } from '@/hooks/useDeleteProject';
import { useXConnect } from '@/hooks/useXConnect';
import { useTimeline } from '@/hooks/useTimeline';
import { useRenderAsset } from '@/hooks/useRenderAsset';
import { useRenderSettings } from '@/hooks/useRenderSettings';
import { useProviderKeyStatus } from '@/hooks/useProviderKeyStatus';
import { useSetEnvSecret } from '@/hooks/useSetEnvSecret';
import type { Orientation } from '@/hooks/useTimeline';
import { toast } from '@/hooks/useToast';
import { CommandRegistryProvider } from '@/contexts/CommandRegistryContext';
import { MountKeyProvider } from '@/contexts/MountKeyContext';
import type { UiActionMap } from '@/lib/ui-actions';
import type { MediaItem, AssetType, ClipState, PendingState } from '@/components/sidebar/types';
import { DEFAULT_RENDER_SETTINGS, getDefaultRenderSettings, isSubtitleLanguage, storedToRenderSettings, type TranscriptInfo } from '@/components/center-stage/render-settings-types';
import type { RenderSettings } from '@/components/center-stage/render-settings-types';

const ASSET_TYPES = new Set<string>(['image', 'audio', 'script', 'plan', 'character']);
const CLIP_TYPES = new Set<string>(['video', 'final']);

function humanizeId(id: string): string {
  const rawName = id.replace(/^[a-z]+-/, '');
  return rawName
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatAssetCount(count: number): string {
  return count === 1 ? '1 asset' : `${count} assets`;
}

export function HomePage() {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [statusOpen, setStatusOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveInitialResponse, setArchiveInitialResponse] = useState<ArchiveSearchResponse | null>(null);
  const [archiveInitialError, setArchiveInitialError] = useState<string | null>(null);
  const [archiveInitialLoading, setArchiveInitialLoading] = useState(false);
  const [archiveInitialQuery, setArchiveInitialQuery] = useState('');
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<string | null>(null);
  const [deleteProjectSubmitting, setDeleteProjectSubmitting] = useState(false);
  const [trimAssetId, setTrimAssetId] = useState<string | null>(null);
  const [cropTarget, setCropTarget] = useState<{ assetId: string; ratio?: string } | null>(null);
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [viewerSize, setViewerSize] = useState<ViewerSize>('landscape');
  const [viewerFlipped, setViewerFlipped] = useState(false);
  const [pendingFilePosition, setPendingFilePosition] = useState<number | null>(null);
  const [pendingBackTab, setPendingBackTab] = useState<'settings' | 'files' | 'history' | null>(null);
  const [renderSettings, setRenderSettings] = useState<RenderSettings>(DEFAULT_RENDER_SETTINGS);
  const [transcriptInfo, setTranscriptInfo] = useState<TranscriptInfo | null>(null);
  const [renderingOverrides, setRenderingOverrides] = useState<Map<string, string>>(new Map());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [timelineSlotIndex, setTimelineSlotIndex] = useState<number | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [genPanel, setGenPanel] = useState<{ category: 'video' | 'image'; prompt: string } | null>(null);
  // Optimistic placeholder tiles for just-enqueued generations, shown in the
  // clips bar until the real asset surfaces via sync (or the safety expiry).
  const [ghostClips, setGhostClips] = useState<
    { id: string; category: 'video' | 'image'; prompt: string; startedAt: number }[]
  >([]);
  const [characterDialog, setCharacterDialog] = useState<{
    initialSlug: string | null;
    initialProfile?: CharacterProfile;
    onProfileSaved?: (profile: CharacterProfile) => void;
  } | null>(null);
  const [postPanel, setPostPanel] = useState<{ assetId: string | null; text: string } | null>(null);
  const [projectExportAssetId, setProjectExportAssetId] = useState<string | null>(null);
  const [planEmptyOverride, setPlanEmptyOverride] = useState(false);
  const [planOpenKey, setPlanOpenKey] = useState(0);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [audioReplace, setAudioReplace] = useState<{ videoId: string; videoSlug: string; audioId: string; audioSlug: string } | null>(null);
  const [audioReplaceSubmitting, setAudioReplaceSubmitting] = useState(false);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const genPanelRef = useRef<GenPreviewPanelHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevStatusOpenRef = useRef(false);

  const { callTool, state } = useMcpConnection();
  const { upload } = useUploadFile();
  const { projectSlug, setProjectSlug } = useDefaultProject(callTool, state);
  const { sync, syncCount, result } = useSync(callTool);
  const { switchProject } = useSwitchProject(callTool);
  const { projects, refresh: refreshProjects } = useListProjects(callTool);
  const { createProject } = useCreateProject(callTool);
  const { renameProject } = useRenameProject(callTool);
  const { deleteProject } = useDeleteProject(callTool);
  const { connect: connectX } = useXConnect(callTool, {
    onConnected: () => toast({ title: 'X connected', description: 'Your X account is linked.', duration: 3000 }),
    onError: (message) => toast({ title: 'X connect failed', description: message, duration: 5000 }),
  });
  const { listAssets, assets: assetList, clearAssets, removeAsset, markAssetSeenLocal } = useListAssets(callTool);
  const markAssetSeen = useMarkAssetSeen(callTool);
  const { timeline, fetchTimeline, setCurrentOrientation, addAudio, moveAudio, removeAudio, updateAudio } = useTimeline(callTool);
  const { renderAsset } = useRenderAsset(callTool);
  const { generate: generateCharacter, submitting: characterSubmitting } = useGenerateCharacter(callTool);
  const { extract: extractSkeleton } = useExtractSkeleton(sync);
  const { fetchRenderSettings } = useRenderSettings(callTool);
  const { entries: activityEntries, loading: activityLoading, fetch: fetchActivity } = useProjectActivity(callTool);
  const {
    data: providerKeyStatus,
    loading: providerKeyStatusLoading,
    error: providerKeyStatusError,
    refresh: refreshProviderKeyStatus,
  } = useProviderKeyStatus(callTool, state);
  const {
    setEnvSecret,
    saving: envSecretSaving,
    error: envSecretError,
  } = useSetEnvSecret(callTool, state);

  useEffect(() => {
    if (state === 'ready') refreshProjects();
  }, [state, refreshProjects]);

  // Fetch activity when status drawer opens
  useEffect(() => {
    if (statusOpen && projectSlug) {
      fetchActivity(projectSlug);
    }
  }, [statusOpen, projectSlug, fetchActivity]);

  // Refresh activity after each sync so async job failures surface live
  useEffect(() => {
    if (statusOpen && projectSlug && syncCount > 0) {
      fetchActivity(projectSlug);
    }
  }, [syncCount, statusOpen, projectSlug, fetchActivity]);

  // Refocus ChatInput after StatusDrawer closes
  useEffect(() => {
    if (prevStatusOpenRef.current && !statusOpen) {
      chatInputRef.current?.focus();
    }
    prevStatusOpenRef.current = statusOpen;
  }, [statusOpen]);

  // Global focus lock: prevent focus from leaving ChatInput on non-form clicks.
  // mousedown + preventDefault stops the browser from moving focus while still
  // allowing click handlers to fire normally.
  useEffect(() => {
    if (statusOpen || settingsOpen || archiveOpen || genPanel != null) return;

    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;

      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
          || tag === 'VIDEO' || tag === 'AUDIO') return;
      if (target.isContentEditable) return;

      // Allow Radix portaled content (dropdowns, popovers, context menus, dialogs)
      if (target.closest('[data-radix-popper-content-wrapper]')) return;
      if (target.closest('[data-radix-menu-content]')) return;
      if (target.closest('[role="dialog"]')) return;

      // Allow drag initiation on draggable elements
      if (target.closest('[draggable="true"]')) return;

      e.preventDefault();
      chatInputRef.current?.focus();
    };

    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [statusOpen, settingsOpen, archiveOpen, genPanel]);

  // Refresh assets after each sync or sort change; clear optimistic overrides
  useEffect(() => {
    if (!projectSlug || syncCount === 0) return;
    listAssets(projectSlug, sortOrder);
    return () => {
      setRenderingOverrides(new Map());
      setDeletingIds(new Set());
    };
  }, [projectSlug, syncCount, sortOrder, listAssets]);

  // Refresh timeline after each sync
  useEffect(() => {
    if (!projectSlug || syncCount === 0) return;
    fetchTimeline(projectSlug);
  }, [projectSlug, syncCount, fetchTimeline]);


  const mediaItems = useMemo(() => {
    if (!assetList) return [] as Array<MediaItem & { created_at: string }>;
    const failedMap = new Map<string, { failMsg: string; failedAt: string; taskType: string; prompt: string | null }>();
    const pendingMap = new Map<string, { state: PendingState; progress: number; taskType: string; prompt: string | null; startedAt: number | null }>();
    if (result) {
      for (const f of result.failed) {
        failedMap.set(f.assetId, { failMsg: f.failMsg, failedAt: f.failedAt, taskType: f.taskType, prompt: f.prompt });
      }
      for (const p of result.pending) {
        pendingMap.set(p.assetId, { state: p.state as PendingState, progress: p.progress, taskType: p.taskType, prompt: p.prompt, startedAt: p.startedAt });
      }
    }

    return assetList.map((asset) => {
      let status: ClipState = (renderingOverrides.get(asset.id) ?? asset.status ?? 'ready') as ClipState;
      const failed = failedMap.get(asset.id);
      if (failed) status = 'error';
      if (deletingIds.has(asset.id)) status = 'deleting';
      const pending = pendingMap.get(asset.id);
      const prompt = asset.prompt ?? pending?.prompt ?? failed?.prompt ?? null;
      return {
        id: asset.id,
        type: asset.type as AssetType,
        slug: `@${asset.id}`,
        title: humanizeId(asset.id),
        filePath: asset.media_url ?? '',
        thumbnailSrc: asset.thumbnail_url,
        status,
        created_at: asset.created_at,
        createdAt: asset.created_at,
        width: asset.width,
        height: asset.height,
        origin: asset.origin,
        prompt,
        renders: asset.renders ?? [],
        duration: asset.duration,
        waveform: asset.waveform,
        frameDirs: asset.frame_dirs,
        archiveId: asset.archive_id,
        archivedAt: asset.archived_at,
        pendingState: pending?.state,
        pendingProgress: pending?.progress,
        pendingTaskType: pending?.taskType,
        pendingStartedAt: pending?.startedAt ?? null,
        failedAt: failed?.failedAt,
        failedMessage: failed?.failMsg,
        failedTaskType: failed?.taskType,
        seenAt: asset.seen_at,
        hasVoice: asset.has_voice ?? null,
      };
    });
  }, [assetList, result, renderingOverrides, deletingIds]);

  const assets = useMemo(() =>
    mediaItems.filter((m) => ASSET_TYPES.has(m.type)),
  [mediaItems]);

  const clips = useMemo(() =>
    mediaItems.filter((m) => CLIP_TYPES.has(m.type)),
  [mediaItems]);

  // Drop ghost tiles once their real asset surfaces via sync, and expire
  // stragglers (e.g. a failed enqueue) so a placeholder never lingers.
  useEffect(() => {
    if (ghostClips.length === 0) return;
    const ids = new Set(mediaItems.map((m) => m.id));
    const cutoff = Date.now() - 90_000;
    setGhostClips((gs) => {
      const next = gs.filter((g) => !ids.has(g.id) && g.startedAt > cutoff);
      return next.length === gs.length ? gs : next;
    });
  }, [mediaItems, ghostClips.length]);

  const handleGenerationSubmitted = useCallback(
    (g: { assetId: string; category: 'video' | 'image'; prompt: string }) => {
      setGhostClips((gs) =>
        gs.some((x) => x.id === g.assetId)
          ? gs
          : [...gs, { id: g.assetId, category: g.category, prompt: g.prompt, startedAt: Date.now() }]);
    },
    [],
  );

  // Ghosts still awaiting their real card, split by where they render.
  const videoGhosts = useMemo(() => {
    const ids = new Set(clips.map((c) => c.id));
    return ghostClips.filter((g) => g.category === 'video' && !ids.has(g.id));
  }, [ghostClips, clips]);
  const imageGhosts = useMemo(() => {
    const ids = new Set(assets.map((a) => a.id));
    return ghostClips.filter((g) => g.category === 'image' && !ids.has(g.id));
  }, [ghostClips, assets]);

  // Whether a generation of the open panel's category is still running —
  // drives the dimmed-but-clickable /generate button.
  const pendingGenForPanel = useMemo(() => {
    if (!genPanel) return false;
    const cat = genPanel.category;
    const live = mediaItems.some((m) =>
      m.type === cat &&
      (m.pendingState === 'queued' || m.pendingState === 'processing') &&
      (m.pendingTaskType?.startsWith('generate') ?? false));
    return live || ghostClips.some((g) => g.category === cat);
  }, [genPanel, mediaItems, ghostClips]);

  const trimItem = useMemo(() =>
    trimAssetId ? mediaItems.find(m => m.id === trimAssetId) ?? null : null,
  [mediaItems, trimAssetId]);


  // Derive the active selection — clear if item was removed from list
  const activeSelection = useMemo(() => {
    if (!selectedItem) return null;
    return mediaItems.find(m => m.id === selectedItem.id) ?? null;
  }, [mediaItems, selectedItem]);

  // While the empty-plan state is showing, prefer the populated plan as soon
  // as the asset appears (e.g. just generated). PlanViewer handles both modes.
  const planAssetForOverride = useMemo(
    () => (planEmptyOverride ? mediaItems.find((m) => m.id === 'plan') ?? null : null),
    [planEmptyOverride, mediaItems],
  );
  const planCenterStageOpen = !settingsOpen && genPanel == null && (activeSelection?.type === 'plan' || planEmptyOverride);

  const handleMarkSeen = useCallback((assetId: string) => {
    if (!projectSlug) return;
    markAssetSeenLocal(assetId);
    void markAssetSeen(assetId, projectSlug);
  }, [projectSlug, markAssetSeenLocal, markAssetSeen]);

  const handleSelectItem = useCallback((item: MediaItem) => {
    setSettingsOpen(false);
    setArchiveOpen(false);
    setTemplatesOpen(false);
    setSelectedItem(item);
    setGenPanel(null);
    setTimelineSlotIndex(null);
    setPlanEmptyOverride(false);
    if (item.type === 'plan') setPlanOpenKey((key) => key + 1);
    const isClip = item.type === 'video' || item.type === 'final';
    setViewerSize(isClip && timeline?.currentOrientation ? timeline.currentOrientation : 'original');
  }, [timeline]);

  // Open the /templates marketplace center stage, clearing the other
  // center-stage views (an active selection outranks templates in the cascade).
  const openTemplates = useCallback(() => {
    setSettingsOpen(false);
    setArchiveOpen(false);
    setSelectedItem(null);
    setGenPanel(null);
    setTimelineSlotIndex(null);
    setPlanEmptyOverride(false);
    setTemplatesOpen(true);
  }, []);

  // After a plan is generated from a /templates preview, leave the marketplace
  // and open /plan to work on the freshly-generated plan.
  const handlePlanGenerated = useCallback(() => {
    setTemplatesOpen(false);
    setSettingsOpen(false);
    setArchiveOpen(false);
    const planAsset = mediaItems.find((m) => m.id === 'plan');
    if (planAsset) {
      handleSelectItem(planAsset);
    } else {
      setPlanOpenKey((key) => key + 1);
      setSelectedItem(null);
      setGenPanel(null);
      setTimelineSlotIndex(null);
      setPlanEmptyOverride(true);
    }
  }, [mediaItems, handleSelectItem]);

  const handleViewerSizeChange = useCallback((size: ViewerSize) => {
    setViewerSize(size);
    if (projectSlug) setCurrentOrientation(projectSlug, size);
  }, [projectSlug, setCurrentOrientation]);

  const settingsOrientation = useMemo<Orientation>(
    () => viewerSize !== 'original' ? viewerSize as Orientation : 'landscape',
    [viewerSize],
  );

  // Sync render settings from dedicated endpoint when selection or orientation changes
  const prevSettingsKeyRef = useRef<string>('');
  useEffect(() => {
    if (!activeSelection?.id || !projectSlug) return;
    const key = `${activeSelection.id}:${settingsOrientation}`;
    if (key === prevSettingsKeyRef.current) return;
    prevSettingsKeyRef.current = key;
    let cancelled = false;
    fetchRenderSettings(activeSelection.id, projectSlug).then((all) => {
      if (cancelled) return;
      const stored = all?.settings?.[settingsOrientation];
      setRenderSettings(stored
        ? storedToRenderSettings(stored, (id) => mediaItems.find(m => m.id === id)?.filePath ?? null)
        : getDefaultRenderSettings(settingsOrientation));
      setTranscriptInfo(all?.transcript ?? null);
    });
    return () => { cancelled = true; };
  }, [activeSelection?.id, projectSlug, settingsOrientation, fetchRenderSettings, mediaItems]);

  const previewData = useTimelinePreview(timeline, mediaItems, projectSlug, settingsOrientation);

  const frameRef = useRef(0);
  const rafRef = useRef(0);

  const handleFrameUpdate = useCallback((frame: number) => {
    frameRef.current = frame;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        setCurrentFrame(frameRef.current);
        rafRef.current = 0;
      });
    }
  }, []);

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const handleRender = useCallback(async (settings?: RenderSettings) => {
    if (!projectSlug || !activeSelection) return;
    const orient = viewerSize !== 'original' ? viewerSize as Orientation : undefined;
    // Optimistically show rendering animation immediately
    if (orient) {
      setRenderingOverrides(prev => new Map(prev).set(activeSelection.id, `render-queued-${orient}`));
    }
    await renderAsset(activeSelection.id, projectSlug, orient, settings);
    sync(projectSlug);
  }, [projectSlug, activeSelection, renderAsset, viewerSize, sync]);

  // Sync on mount + poll every 5s while page is active
  useEffect(() => {
    if (!projectSlug) return;
    sync(projectSlug);
    fetchTimeline(projectSlug).then(config => {
      if (config?.currentOrientation) setViewerSize(config.currentOrientation);
    });
    const id = setInterval(() => sync(projectSlug), 5_000);
    return () => clearInterval(id);
  }, [projectSlug, sync, fetchTimeline]);

  const triggerUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDrop = useCallback((files: File[]) => {
    if (!projectSlug) return;
    const uploads = files.map((file) => upload(projectSlug, file));
    Promise.allSettled(uploads).then(() => {
      listAssets(projectSlug, sortOrder);
      sync(projectSlug);
    });
  }, [projectSlug, upload, sync, listAssets, sortOrder]);

  const handleDeleteClip = useCallback(async (video: MediaItem) => {
    if (!projectSlug) return;
    setDeletingIds((prev) => new Set(prev).add(video.id));
    try {
      const result = await callTool('delete_asset', { asset_id: video.id, project_slug: projectSlug });
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        toast({ title: 'Delete failed', description: content?.[0]?.text ?? 'delete_asset failed', duration: 5000 });
        return;
      }
      removeAsset(video.id);
      setSelectedItem((current) => current?.id === video.id ? null : current);
      setTrimAssetId((current) => current === video.id ? null : current);
      await Promise.all([
        fetchTimeline(projectSlug),
        listAssets(projectSlug, sortOrder),
      ]);
      sync(projectSlug);
    } catch (error) {
      toast({ title: 'Delete failed', description: error instanceof Error ? error.message : String(error), duration: 5000 });
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(video.id);
        return next;
      });
    }
  }, [callTool, fetchTimeline, listAssets, projectSlug, removeAsset, sortOrder, sync]);

  const handleRecoverClip = useCallback(async (video: MediaItem) => {
    if (!projectSlug) return;
    try {
      const result = await callTool('recover_asset', { asset_id: video.id, project_slug: projectSlug });
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        toast({ title: 'Recover failed', description: content?.[0]?.text ?? 'recover_asset failed', duration: 5000 });
        return;
      }
      await listAssets(projectSlug, sortOrder);
      sync(projectSlug);
    } catch (error) {
      toast({ title: 'Recover failed', description: error instanceof Error ? error.message : String(error), duration: 5000 });
    }
  }, [callTool, listAssets, projectSlug, sortOrder, sync]);

  const handleAudioDroppedOnVideo = useCallback((video: MediaItem, audioId: string, audioSlug: string) => {
    setAudioReplace({ videoId: video.id, videoSlug: video.slug, audioId, audioSlug });
  }, []);

  const handleConfirmAudioReplace = useCallback(async () => {
    if (!audioReplace || !projectSlug) return;
    setAudioReplaceSubmitting(true);
    try {
      const result = await callTool('replace_video_audio', {
        project_slug: projectSlug,
        asset_id: audioReplace.videoId,
        audio_asset_id: audioReplace.audioId,
      });
      if (result.isError) {
        const msg = (result.content as Array<{ type: string; text: string }> | undefined)?.[0]?.text ?? 'replace_video_audio failed';
        toast({ title: 'Replace audio failed', description: msg, duration: 5000 });
      } else {
        toast({ title: 'Audio replaced', description: `${audioReplace.videoSlug} ← ${audioReplace.audioSlug}`, duration: 2500 });
        sync(projectSlug);
      }
    } finally {
      setAudioReplaceSubmitting(false);
      setAudioReplace(null);
    }
  }, [audioReplace, projectSlug, callTool, sync]);

  const resetOpenScreens = useCallback(() => {
    setStatusOpen(false);
    setSettingsOpen(false);
    setArchiveOpen(false);
    setArchiveInitialResponse(null);
    setArchiveInitialError(null);
    setArchiveInitialLoading(false);
    setTrimAssetId(null);
    setCropTarget(null);
    setSelectedItem(null);
    setViewerFlipped(false);
    setPendingFilePosition(null);
    setPendingBackTab(null);
    setTimelineSlotIndex(null);
    setGenPanel(null);
    setCharacterDialog(null);
    setPostPanel(null);
    setProjectExportAssetId(null);
    setPlanEmptyOverride(false);
    setAudioReplace(null);
    setAudioReplaceSubmitting(false);
  }, []);

  const handleProjectChange = useCallback(async (slug: string) => {
    resetOpenScreens();
    clearAssets();
    setProjectSlug(slug);
    await switchProject(slug);
    await listAssets(slug, sortOrder);
  }, [resetOpenScreens, setProjectSlug, clearAssets, switchProject, listAssets, sortOrder]);

  const handleOpenAsset = useCallback((assetId: string) => {
    const item = mediaItems.find(m => m.id === assetId);
    if (item) handleSelectItem(item);
  }, [mediaItems, handleSelectItem]);

  const handleAnimateCommand = useCallback((text: string) => {
    // Detect /delete @slug and mark asset as deleting immediately
    const deleteMatch = text.match(/^\/delete\s+@([a-z0-9_-]+)/i);
    if (deleteMatch) {
      const assetId = deleteMatch[1];
      setDeletingIds((prev) => new Set(prev).add(assetId));
    }
    chatInputRef.current?.animateAndSend(text);
  }, []);

  const handleAnimateEdit = useCallback((text: string) => {
    chatInputRef.current?.animateAndEdit(text);
  }, []);

  const handleSlotClick = useCallback((slotIndex: number) => {
    setSettingsOpen(false);
    setArchiveOpen(false);
    setTemplatesOpen(false);
    setSelectedItem(null);
    setGenPanel(null);
    setTimelineSlotIndex(slotIndex);
  }, []);

  const handleAfterDispatch = useCallback((toolName: string, toolArgs: Record<string, string | number | boolean | string[]>) => {
    if (!projectSlug) return;
    fetchTimeline(projectSlug);
    listAssets(projectSlug, sortOrder);
    sync(projectSlug);
    if (toolName === 'delete_asset') {
      const assetId = typeof toolArgs.asset_id === 'string' ? toolArgs.asset_id : String(toolArgs.asset_id);
      removeAsset(assetId);
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(assetId);
        return next;
      });
    }
  }, [projectSlug, fetchTimeline, listAssets, sortOrder, sync, removeAsset]);

  const handleActivityRewound = useCallback(async () => {
    if (!projectSlug) return;
    clearAssets();
    setArchiveOpen(false);
    setSelectedItem(null);
    setTimelineSlotIndex(null);
    setGenPanel(null);
    setPlanEmptyOverride(false);
    setRenderingOverrides(new Map());
    setDeletingIds(new Set());
    sync(projectSlug);
    refreshProjects();
    await Promise.all([
      listAssets(projectSlug, sortOrder),
      fetchTimeline(projectSlug),
      fetchActivity(projectSlug),
    ]);
  }, [projectSlug, clearAssets, sync, refreshProjects, listAssets, sortOrder, fetchTimeline, fetchActivity]);

  const assetSlugs = useMemo(() => mediaItems.map((m) => m.slug), [mediaItems]);

  const slotRefs = useMemo(() => {
    const slots = timeline?.slots;
    let lastFilled = -1;
    if (slots) {
      for (let i = slots.length - 1; i >= 0; i--) {
        if (slots[i]?.slug) { lastFilled = i; break; }
      }
    }
    const count = Math.max(lastFilled + 2, 5);
    return Array.from({ length: count }, (_, i) => ({
      ref: `@s${String(i + 1).padStart(2, '0')}`,
      assetSlug: slots?.[i]?.slug || '',
    }));
  }, [timeline]);

  const slotBoundaries = useMemo(() => {
    const n = slotRefs.length;
    if (n === 0) return [];
    const total = previewData.totalDurationInFrames;
    const out: Array<{ leftPct: number; frame: number }> = [];
    for (let i = 0; i <= n; i++) {
      const leftPct = (i / n) * 100;
      const frame = i < previewData.slotOffsets.length
        ? previewData.slotOffsets[i]
        : total;
      out.push({ leftPct, frame });
    }
    return out;
  }, [slotRefs.length, previewData.slotOffsets, previewData.totalDurationInFrames]);

  const { isDragging } = useWindowDropzone({ onDrop: handleDrop });

  const applySubsSetting = useCallback((field: string, value: string) => {
    const key = field.trim().toLowerCase();
    const rawValue = value.trim();
    const normalizedValue = rawValue.toLowerCase();
    setRenderSettings(prev => {
      switch (key) {
        case 'on': return { ...prev, subtitlesEnabled: true };
        case 'off': return { ...prev, subtitlesEnabled: false };
        case 'enabled': {
          const on = normalizedValue === 'on' || normalizedValue === 'true' || normalizedValue === '1' || normalizedValue === 'yes';
          return { ...prev, subtitlesEnabled: on };
        }
        case 'language':
        case 'lang': {
          return isSubtitleLanguage(normalizedValue) ? { ...prev, subtitleLanguage: normalizedValue } : prev;
        }
        case 'style': {
          if (normalizedValue === 'impact' || normalizedValue === 'highlight') return { ...prev, subtitleStyle: normalizedValue };
          return prev;
        }
        case 'position': {
          const posMap: Record<string, 'top' | 'middle' | 'bottom'> = { top: 'top', mid: 'middle', middle: 'middle', bottom: 'bottom' };
          const pos = posMap[normalizedValue];
          return pos ? { ...prev, subtitlePosition: pos } : prev;
        }
        case 'fontsize':
        case 'size': {
          const sizeMap: Record<string, 'small' | 'medium' | 'large'> = {
            s: 'small',
            sm: 'small',
            small: 'small',
            m: 'medium',
            md: 'medium',
            medium: 'medium',
            l: 'large',
            lg: 'large',
            large: 'large',
          };
          const sz = sizeMap[normalizedValue];
          return sz ? { ...prev, fontSize: sz } : prev;
        }
        case 'textcolor':
        case 'color': return { ...prev, textColor: rawValue };
        case 'highlightcolor':
        case 'highlight': return { ...prev, highlightColor: rawValue };
        case 'stroke':
        case 'strokewidth': {
          const n = Math.max(0, Math.min(20, parseInt(rawValue, 10) || 0));
          return { ...prev, strokeWidth: n };
        }
        case 'strokecolor': return { ...prev, strokeColor: rawValue };
        case 'shadow':
        case 'shadowblur': {
          const n = Math.max(0, Math.min(30, parseInt(rawValue, 10) || 0));
          return { ...prev, shadowBlur: n };
        }
        case 'shadowopacity': {
          const n = Math.max(0, Math.min(100, parseInt(rawValue, 10) || 0));
          return { ...prev, shadowOpacity: n };
        }
        default: return prev;
      }
    });
  }, []);

  const applyAudioSetting = useCallback((field: string, value: string) => {
    const num = Math.max(0, parseInt(value, 10) || 0);
    setRenderSettings(prev => {
      switch (field) {
        case 'audioVolume':
        case 'volume': return { ...prev, audioVolume: Math.min(num, 100) };
        case 'audioFadeIn':
        case 'fadeIn':
        case 'fade-in': return { ...prev, audioFadeIn: num };
        case 'audioFadeOut':
        case 'fadeOut':
        case 'fade-out': return { ...prev, audioFadeOut: num };
        default: return prev;
      }
    });
  }, []);

  const applyOsgSetting = useCallback((field: string, value: string) => {
    setRenderSettings(prev => {
      if (field === 'position' || field === 'osgPosition') {
        const posMap: Record<string, RenderSettings['osgPosition']> = {
          tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right',
          'top-left': 'top-left', 'top-right': 'top-right', 'bottom-left': 'bottom-left', 'bottom-right': 'bottom-right',
        };
        const pos = posMap[value];
        return pos ? { ...prev, osgPosition: pos } : prev;
      }
      if (field === 'size' || field === 'osgSize') {
        const sizeMap: Record<string, RenderSettings['osgSize']> = {
          s: 'small', m: 'medium', l: 'large',
          small: 'small', medium: 'medium', large: 'large',
        };
        const size = sizeMap[value.toLowerCase()];
        return size ? { ...prev, osgSize: size } : prev;
      }
      if (field === 'clear') {
        return { ...prev, osgAssetId: null, osgAssetSrc: null };
      }
      // Treat as asset id (@ prefix already stripped by command parser)
      const assetId = field.startsWith('@') ? field.slice(1) : field;
      const item = mediaItems.find(m => m.id === assetId);
      if (item) {
        return { ...prev, osgAssetId: assetId, osgAssetSrc: item.filePath ?? null };
      }
      return prev;
    });
  }, [mediaItems]);

  const handleSettingsClick = useCallback(() => {
    setSettingsOpen((open) => !open);
    setArchiveOpen(false);
    setStatusOpen(false);
    void refreshProviderKeyStatus();
  }, [refreshProviderKeyStatus]);

  const openArchive = useCallback((query?: string) => {
    const trimmedQuery = query?.trim() ?? '';
    setStatusOpen(false);
    setSettingsOpen(false);
    setSelectedItem(null);
    setTimelineSlotIndex(null);
    setGenPanel(null);
    setPlanEmptyOverride(false);
    setArchiveInitialResponse(null);
    setArchiveInitialError(null);
    setArchiveInitialLoading(true);
    setArchiveInitialQuery(trimmedQuery);
    setArchiveOpen(true);

    if (state !== 'ready') {
      setArchiveInitialError('MCP is not ready');
      setArchiveInitialLoading(false);
      return;
    }

    void callTool('search_archive', {
      ...(trimmedQuery ? { query: trimmedQuery } : {}),
      limit: 20,
      offset: 0,
      sort: 'newest',
      include_transcript: false,
      presign_media: true,
    }).then((result) => {
      const content = result.content as Array<{ type: string; text: string }>;
      if (result.isError) {
        setArchiveInitialError(content[0]?.text ?? 'Archive search failed');
        setArchiveInitialResponse(null);
        return;
      }
      const parsed = JSON.parse(content[0]?.text ?? '{"results":[],"total":0,"offset":0,"limit":20,"has_more":false}') as ArchiveSearchResponse;
      setArchiveInitialResponse(parsed);
      setArchiveInitialError(null);
    }).catch((error: unknown) => {
      setArchiveInitialError(error instanceof Error ? error.message : String(error));
      setArchiveInitialResponse(null);
    }).finally(() => {
      setArchiveInitialLoading(false);
    });
  }, [callTool, state]);

  const handleArchiveClick = useCallback(() => {
    if (archiveOpen) {
      setArchiveOpen(false);
      return;
    }
    openArchive();
  }, [archiveOpen, openArchive]);

  const handleArchiveRestoreComplete = useCallback((response: RestoreResponse) => {
    if (!projectSlug) return;
    sync(projectSlug);
    void listAssets(projectSlug, sortOrder);
    toast({
      title: 'Archive restore queued',
      description: `${response.restored.length} restoring, ${response.skipped.length} skipped`,
      duration: 3000,
    });
  }, [projectSlug, sync, listAssets, sortOrder]);

  const handleCreateProject = useCallback(async (slug: string) => {
    const cleaned = slug.trim();
    if (!cleaned) return;
    const created = await createProject(cleaned);
    if (!created) {
      toast({ title: 'Create project failed', description: `Could not create "${cleaned}"`, duration: 5000 });
      return;
    }
    await handleProjectChange(cleaned);
    refreshProjects();
  }, [createProject, handleProjectChange, refreshProjects]);

  const handleRenameProject = useCallback(async (newSlug: string) => {
    const cleaned = newSlug.trim();
    if (!projectSlug || !cleaned || cleaned === projectSlug) return;
    const ok = await renameProject(projectSlug, cleaned);
    if (!ok) {
      toast({ title: 'Rename project failed', description: `Could not rename to "${cleaned}"`, duration: 5000 });
      return;
    }
    await handleProjectChange(cleaned);
    refreshProjects();
  }, [projectSlug, renameProject, handleProjectChange, refreshProjects]);

  const handleRequestDeleteProject = useCallback((slug: string) => {
    const target = slug.trim().replace(/^@/, '') || projectSlug;
    if (!target) return;
    if (!projects.some((p) => p.slug === target)) {
      toast({ title: 'Delete project failed', description: `No project "${target}"`, duration: 4000 });
      return;
    }
    if (projects.length <= 1) {
      toast({ title: 'Cannot delete', description: 'Create another project before deleting this one', duration: 4000 });
      return;
    }
    refreshProjects();
    setDeleteProjectTarget(target);
  }, [projectSlug, projects, refreshProjects]);

  const deleteProjectAssetCount = useMemo(() => {
    if (!deleteProjectTarget) return 0;
    if (deleteProjectTarget === projectSlug && assetList) return assetList.length;
    return projects.find((p) => p.slug === deleteProjectTarget)?.asset_count ?? 0;
  }, [deleteProjectTarget, projectSlug, assetList, projects]);

  const handleConfirmDeleteProject = useCallback(async () => {
    if (!deleteProjectTarget) return;
    setDeleteProjectSubmitting(true);
    try {
      const result = await deleteProject(deleteProjectTarget);
      if (!result.ok) {
        toast({ title: 'Delete project failed', description: result.error, duration: 5000 });
        return;
      }
      const nextSlug = result.value.default_project_slug ?? projects.find((p) => p.slug !== deleteProjectTarget)?.slug;
      refreshProjects();
      if (deleteProjectTarget === projectSlug && nextSlug) {
        await handleProjectChange(nextSlug);
      }
      toast({ title: 'Project deleted', description: deleteProjectTarget, duration: 2500 });
    } finally {
      setDeleteProjectSubmitting(false);
      setDeleteProjectTarget(null);
    }
  }, [deleteProjectTarget, deleteProject, projects, projectSlug, refreshProjects, handleProjectChange]);

  const handleCloseViewer = useCallback(() => {
    setSelectedItem(null);
    setGenPanel(null);
    setTimelineSlotIndex(null);
    setArchiveOpen(false);
    setSettingsOpen(false);
    setTrimAssetId(null);
    setCropTarget(null);
    setViewerFlipped(false);
    setPendingFilePosition(null);
    setPendingBackTab(null);
    setPlanEmptyOverride(false);
  }, []);

  const setSidebarsCollapsed = useCallback((side: string, collapsed: boolean) => {
    const s = side.trim().toLowerCase();
    if (s !== 'right') setLeftCollapsed(collapsed);
    if (s !== 'left') setRightCollapsed(collapsed);
  }, []);

  const timelineFps = previewData.fps || 30;

  const resolveTimelineAudio = useCallback((ref: string) => {
    const clean = ref.trim().replace(/^@/, '');
    return timeline?.audio?.find((a) => a.id === clean || a.slug === clean || a.slug === `@${clean}`);
  }, [timeline]);

  const handleTimelineAudioAdd = useCallback((assetId: string, startSec: string, durationSec: string) => {
    if (!projectSlug) return;
    const cleaned = assetId.trim().replace(/^@/, '');
    if (!cleaned.startsWith('aud-')) {
      toast({ title: 'Audio add failed', description: `Expected an aud-* asset, got "${cleaned}"`, duration: 4000 });
      return;
    }
    const startFrame = Math.max(0, Math.round((parseFloat(startSec) || 0) * timelineFps));
    const parsedDuration = Math.round((parseFloat(durationSec) || 0) * timelineFps);
    void addAudio(projectSlug, cleaned, startFrame, parsedDuration > 0 ? parsedDuration : undefined).then((ok) => {
      if (!ok) toast({ title: 'Audio add failed', description: cleaned, duration: 4000 });
    });
  }, [projectSlug, addAudio, timelineFps]);

  const handleTimelineAudioMove = useCallback((audioRef: string, startSec: string) => {
    if (!projectSlug) return;
    const clip = resolveTimelineAudio(audioRef);
    if (!clip) {
      toast({ title: 'Audio move failed', description: `No timeline audio clip "${audioRef}"`, duration: 4000 });
      return;
    }
    const startFrame = Math.max(0, Math.round((parseFloat(startSec) || 0) * timelineFps));
    void moveAudio(projectSlug, clip.id, startFrame).then((ok) => {
      if (!ok) toast({ title: 'Audio move failed', description: clip.slug, duration: 4000 });
    });
  }, [projectSlug, resolveTimelineAudio, moveAudio, timelineFps]);

  const handleTimelineAudioRemove = useCallback((audioRef: string) => {
    if (!projectSlug) return;
    const clip = resolveTimelineAudio(audioRef);
    if (!clip) {
      toast({ title: 'Audio remove failed', description: `No timeline audio clip "${audioRef}"`, duration: 4000 });
      return;
    }
    void removeAudio(projectSlug, clip.id).then((ok) => {
      if (!ok) toast({ title: 'Audio remove failed', description: clip.slug, duration: 4000 });
    });
  }, [projectSlug, resolveTimelineAudio, removeAudio]);

  const handleTimelineAudioUpdate = useCallback((audioRef: string, field: string, value: string) => {
    if (!projectSlug) return;
    const clip = resolveTimelineAudio(audioRef);
    if (!clip) {
      toast({ title: 'Audio update failed', description: `No timeline audio clip "${audioRef}"`, duration: 4000 });
      return;
    }
    const num = parseFloat(value);
    if (!Number.isFinite(num)) {
      toast({ title: 'Audio update failed', description: `Invalid value "${value}"`, duration: 4000 });
      return;
    }
    const key = field.trim().toLowerCase();
    const fields = key === 'volume'
      ? { volume: Math.max(0, Math.min(100, num)) }
      : key === 'fade-in' || key === 'fadein'
        ? { fadeIn: Math.max(0, num) }
        : key === 'fade-out' || key === 'fadeout'
          ? { fadeOut: Math.max(0, num) }
          : null;
    if (!fields) {
      toast({ title: 'Audio update failed', description: `Unknown field "${field}" (volume | fade-in | fade-out)`, duration: 4000 });
      return;
    }
    void updateAudio(projectSlug, clip.id, fields).then((ok) => {
      if (!ok) toast({ title: 'Audio update failed', description: clip.slug, duration: 4000 });
    });
  }, [projectSlug, resolveTimelineAudio, updateAudio]);

  const handleExtractSkeletonCommand = useCallback((assetId: string) => {
    if (!projectSlug) return;
    const cleaned = assetId.trim().replace(/^@/, '');
    const item = mediaItems.find((m) => m.id === cleaned);
    if (!item || !(item.type === 'image' || item.type === 'character') || !item.filePath) {
      toast({ title: 'Pose extraction failed', description: `No image or character asset "${cleaned}"`, duration: 4000 });
      return;
    }
    void extractSkeleton({ projectSlug, sourceAssetId: item.id, sourceImageUrl: item.filePath });
  }, [projectSlug, mediaItems, extractSkeleton]);

  const handleRewindCommand = useCallback((commitHash: string) => {
    const hash = commitHash.trim();
    if (!hash) {
      setStatusOpen(true);
      return;
    }
    if (!projectSlug) return;
    void (async () => {
      const result = await callTool('rewind_project', { commit_hash: hash, project_slug: projectSlug });
      if (result.isError) {
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        toast({ title: 'Rewind failed', description: content?.[0]?.text ?? 'rewind_project failed', duration: 5000 });
        return;
      }
      toast({ title: 'Project rewound', description: hash, duration: 2500 });
      await handleActivityRewound();
    })();
  }, [projectSlug, callTool, handleActivityRewound]);

  const handleShowVoices = useCallback(() => {
    void (async () => {
      const result = await callTool('list_elevenlabs_voices', {});
      const content = result.content as Array<{ type: string; text: string }> | undefined;
      if (result.isError) {
        toast({ title: 'Voices unavailable', description: content?.[0]?.text ?? 'list_elevenlabs_voices failed', duration: 5000 });
        return;
      }
      try {
        const parsed = JSON.parse(content?.[0]?.text ?? '{}') as { voices?: Array<{ voice_id: string; name: string }> };
        const voices = parsed.voices ?? [];
        const shown = voices.slice(0, 12).map((v) => `${v.name} (${v.voice_id})`).join('\n');
        const more = voices.length > 12 ? `\n…and ${voices.length - 12} more` : '';
        toast({ title: `ElevenLabs voices (${voices.length})`, description: `${shown}${more}`, duration: 8000 });
      } catch {
        toast({ title: 'Voices unavailable', description: 'Could not parse voice list', duration: 5000 });
      }
    })();
  }, [callTool]);

  const handleOpenSlotPlayer = useCallback((slot: string) => {
    const slots = timeline?.slots ?? [];
    const cleaned = slot.trim();
    let index: number;
    if (cleaned) {
      const m = cleaned.match(/^@?s?0*(\d+)$/i);
      if (!m) {
        toast({ title: 'Invalid slot', description: `"${cleaned}" — use e.g. @s01`, duration: 4000 });
        return;
      }
      index = parseInt(m[1], 10) - 1;
    } else {
      index = slots.findIndex((s) => s?.slug);
    }
    if (index < 0 || !slots[index]?.slug) {
      toast({ title: 'Slot empty', description: cleaned ? `${cleaned} has no clip assigned` : 'No filled timeline slots', duration: 4000 });
      return;
    }
    handleSlotClick(index);
  }, [timeline, handleSlotClick]);

  const uiActions: UiActionMap = useMemo(() => ({
    open_upload: triggerUpload,
    open_inbox: () => setStatusOpen(true),
    open_status: () => setStatusOpen(true),
    open_trim: (assetId: string) => setTrimAssetId(assetId),
    open_crop: (assetId: string, ratio?: string) => {
      const cleaned = assetId.trim().replace(/^@/, '');
      const target = cleaned || selectedItem?.id || '';
      if (!target) return;
      const item = mediaItems.find((m) => m.id === target || m.slug === `@${target}` || m.slug === target);
      if (item) handleSelectItem(item);
      handleViewerSizeChange('original');
      setCropTarget({ assetId: item?.id ?? target, ratio });
    },
    open_gen: (type: string, prompt: string) => {
      setSettingsOpen(false);
      setArchiveOpen(false);
      setTemplatesOpen(false);
      setSelectedItem(null);
      setTimelineSlotIndex(null);
      const category: 'video' | 'image' = type === 'image' ? 'image' : 'video';
      setGenPanel({ category, prompt: prompt || '' });
    },
    open_gen_video: (prompt: string) => {
      setSettingsOpen(false);
      setArchiveOpen(false);
      setTemplatesOpen(false);
      setSelectedItem(null);
      setTimelineSlotIndex(null);
      setGenPanel({ category: 'video', prompt: prompt || '' });
    },
    open_gen_image: (prompt: string) => {
      setSettingsOpen(false);
      setArchiveOpen(false);
      setTemplatesOpen(false);
      setSelectedItem(null);
      setTimelineSlotIndex(null);
      setGenPanel({ category: 'image', prompt: prompt || '' });
    },
    copy_clipboard: (raw: string) => navigator.clipboard.writeText(raw),
    show_history: (assetId: string) => {
      const item = mediaItems.find(m => m.id === assetId);
      if (item) handleSelectItem(item);
      setPendingBackTab('history');
      setViewerFlipped(true);
    },
    open_asset: handleOpenAsset,
    switch_project: handleProjectChange,
    viewer_set_original: () => handleViewerSizeChange('original'),
    viewer_set_landscape: () => handleViewerSizeChange('landscape'),
    viewer_set_portrait: () => handleViewerSizeChange('portrait'),
    viewer_toggle_info: () => { setPendingBackTab('settings'); setViewerFlipped(f => !f); },
    viewer_focus_file: (pos: number) => {
      setPendingBackTab('files');
      setViewerFlipped(true);
      setPendingFilePosition(pos);
    },
    viewer_show_settings: () => { setPendingBackTab('settings'); setViewerFlipped(true); },
    settings_landscape: () => { handleViewerSizeChange('landscape'); setPendingBackTab('settings'); setViewerFlipped(true); },
    settings_portrait: () => { handleViewerSizeChange('portrait'); setPendingBackTab('settings'); setViewerFlipped(true); },
    settings_square: () => { handleViewerSizeChange('square'); setPendingBackTab('settings'); setViewerFlipped(true); },
    settings_subs: (field: string, value: string) => {
      applySubsSetting(field, value);
      setPendingBackTab('settings');
      setViewerFlipped(true);
    },
    settings_audio: (field: string, value: string) => {
      applyAudioSetting(field, value);
      setPendingBackTab('settings');
      setViewerFlipped(true);
    },
    settings_bg: (mode: string) => {
      if (mode === 'blur' || mode === 'black') {
        setRenderSettings(prev => ({ ...prev, backgroundMode: mode }));
      }
      setPendingBackTab('settings');
      setViewerFlipped(true);
    },
    settings_osg: (field: string, value: string) => {
      applyOsgSetting(field, value);
      setPendingBackTab('settings');
      setViewerFlipped(true);
    },
    gen_prompt: (text: string) => genPanelRef.current?.setField('prompt', text),
    gen_model: (key: string) => genPanelRef.current?.setModel(key),
    gen_aspect: (ratio: string) => genPanelRef.current?.setField('aspect_ratio', ratio),
    gen_duration: (value: string) => genPanelRef.current?.setField('duration', value),
    gen_mode: (value: string) => genPanelRef.current?.setField('mode', value),
    gen_style: (value: string) => genPanelRef.current?.setField('style', value),
    gen_neg: (text: string) => genPanelRef.current?.setField('negative_prompt', text),
    gen_images: (slugs: string) => genPanelRef.current?.setImages(slugs),
    gen_elements: (index: string, field: string, value: string) => genPanelRef.current?.setElement(index, field, value),
    open_character_dialog: (initialSlug: string) => {
      const cleaned = initialSlug.trim();
      setCharacterDialog({ initialSlug: cleaned ? cleaned : null });
    },
    open_post_composer: (assetSlug: string, text: string) => {
      const cleaned = assetSlug.trim().replace(/^@/, '');
      const matched = cleaned
        ? mediaItems.find((m) => m.id === cleaned || m.slug === `@${cleaned}` || m.slug === cleaned) ?? null
        : selectedItem;
      setPostPanel({ assetId: matched?.id ?? null, text: text ?? '' });
    },
    open_plan: () => {
      setSettingsOpen(false);
      setArchiveOpen(false);
      setTemplatesOpen(false);
      const planAsset = mediaItems.find((m) => m.id === 'plan');
      if (planAsset) {
        handleSelectItem(planAsset);
      } else {
        setPlanOpenKey((key) => key + 1);
        setSelectedItem(null);
        setGenPanel(null);
        setTimelineSlotIndex(null);
        setPlanEmptyOverride(true);
      }
    },
    open_templates: openTemplates,
    open_projects: () => setProjectsOpen(true),
    create_project: (slug: string) => { void handleCreateProject(slug); },
    rename_project: (newSlug: string) => { void handleRenameProject(newSlug); },
    delete_project: handleRequestDeleteProject,
    close_viewer: handleCloseViewer,
    sidebar_collapse: (side: string) => setSidebarsCollapsed(side, true),
    sidebar_expand: (side: string) => setSidebarsCollapsed(side, false),
    sidebar_sort: (order: string) => {
      const o = order.trim().toLowerCase();
      if (o === 'newest' || o === 'oldest') setSortOrder(o);
      else setSortOrder((s) => (s === 'newest' ? 'oldest' : 'newest'));
    },
    open_provider_keys: () => {
      setSettingsOpen(true);
      setArchiveOpen(false);
      setTemplatesOpen(false);
      setStatusOpen(false);
      void refreshProviderKeyStatus();
    },
    open_archive: (query: string) => { setTemplatesOpen(false); openArchive(query); },
    timeline_audio_add: handleTimelineAudioAdd,
    timeline_audio_move: handleTimelineAudioMove,
    timeline_audio_remove: handleTimelineAudioRemove,
    timeline_audio_update: handleTimelineAudioUpdate,
    extract_skeleton: handleExtractSkeletonCommand,
    rewind_activity: handleRewindCommand,
    show_voices: handleShowVoices,
    x_connect: () => { void connectX(); },
    open_slot_player: handleOpenSlotPlayer,
  }), [triggerUpload, mediaItems, handleSelectItem, handleOpenAsset, handleProjectChange, handleViewerSizeChange, applySubsSetting, applyAudioSetting, applyOsgSetting, selectedItem, setCropTarget, handleCreateProject, handleRenameProject, handleRequestDeleteProject, handleCloseViewer, setSidebarsCollapsed, refreshProviderKeyStatus, openArchive, handleTimelineAudioAdd, handleTimelineAudioMove, handleTimelineAudioRemove, handleTimelineAudioUpdate, handleExtractSkeletonCommand, handleRewindCommand, handleShowVoices, connectX, handleOpenSlotPlayer, openTemplates]);

  return (
    <MountKeyProvider>
    <CommandRegistryProvider callTool={callTool} state={state} projectSlug={projectSlug} uiActions={uiActions} onAfterDispatch={handleAfterDispatch}>
      <div className="w-screen h-screen bg-background overflow-hidden">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) {
              handleDrop(Array.from(files));
            }
            e.target.value = '';
          }}
        />
        <DropzoneOverlay isDragging={isDragging} />
        <ActivityLogDrawer
          open={statusOpen}
          onClose={() => setStatusOpen(false)}
          entries={activityEntries}
          loading={activityLoading}
          assetSlugs={assetSlugs}
          callTool={callTool}
          projectSlug={projectSlug}
          onRewound={handleActivityRewound}
        />
        <TrimEditor
          open={trimAssetId != null}
          assetId={trimAssetId}
          item={trimItem}
          onClose={() => setTrimAssetId(null)}
          assetSlugs={assetSlugs}
          callTool={callTool}
          projectSlug={projectSlug}
        />
        <div className="grid grid-rows-[48px_1fr_auto] h-full">
          <HomeHeaderBar
            pulseKey={syncCount}
            projectSlug={projectSlug}
            assetCount={assetList?.length}
            callTool={callTool}
            onProjectChange={handleProjectChange}
            onStatusClick={() => setStatusOpen(true)}
            onArchiveClick={handleArchiveClick}
            onSettingsClick={handleSettingsClick}
            onAnimateCommand={handleAnimateCommand}
            archiveActive={archiveOpen}
            settingsActive={settingsOpen}
            projectsOpen={projectsOpen}
            onProjectsOpenChange={setProjectsOpen}
          />

          <div className="flex flex-row overflow-hidden">
            {/* Left Sidebar — Assets */}
            <CollapsibleSidebar
              side="left"
              collapsed={leftCollapsed}
              onToggle={() => setLeftCollapsed(c => !c)}
              expandedWidth="240px"
              collapsedWidth="40px"
              padding="px-2 pt-2 pb-2"
              gap="gap-0"
            >
              <SidebarHeader
                icon={<Grid3x3 className="w-3.5 h-3.5" />}
                title="Assets"
                collapsed={leftCollapsed}
                onToggle={() => setLeftCollapsed(c => !c)}
                side="left"
                sortOrder={sortOrder}
                onSortChange={() => setSortOrder(s => s === 'newest' ? 'oldest' : 'newest')}
              />
              {leftCollapsed ? (
                <div className="flex flex-col items-center gap-2.5 overflow-y-auto flex-1 py-2">
                  {assets.map(item => (
                    <SidebarMicroThumb key={item.id} item={item} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} />
                  ))}
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto space-y-2 pr-2">
                  {sortOrder === 'newest' && imageGhosts.map((g) => (
                    <div key={g.id} className="w-full">
                      <GhostClipCard id={g.id} type="image" prompt={g.prompt} startedAt={g.startedAt} />
                    </div>
                  ))}
                  {assets.map((item) => {
                    const canExtractSkeleton = (item.type === 'image' || item.type === 'character') && !!item.filePath && !!projectSlug;
                    const itemFilePath = item.filePath;
                    const isUnseen = item.seenAt == null && (item.status ?? 'ready') === 'ready';
                    const onMarkSeen = isUnseen && projectSlug ? () => handleMarkSeen(item.id) : undefined;
                    const canProjectExport = !!projectSlug && projects.some((p) => p.slug !== projectSlug);
                    const menu = (
                      <AssetMenu
                        slug={item.slug}
                        filePath={item.filePath}
                        itemType={item.type}
                        onAnimateCommand={handleAnimateCommand}
                        onAnimateEdit={handleAnimateEdit}
                        onExtractSkeleton={canExtractSkeleton && itemFilePath && projectSlug
                          ? () => extractSkeleton({ projectSlug, sourceAssetId: item.id, sourceImageUrl: itemFilePath })
                          : undefined}
                        onMarkSeen={onMarkSeen}
                        onOpenProjectExport={canProjectExport ? () => setProjectExportAssetId(item.id) : undefined}
                        MenuItem={ContextMenuItem}
                      />
                    );
                    return (
                      <div key={item.id} className="w-full">
                        {(item.type === 'image' || item.type === 'character') && <ImageCard item={item} contextMenuContent={menu} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} onMarkSeen={onMarkSeen} onDelete={handleDeleteClip} onRecover={handleRecoverClip} />}
                        {item.type === 'audio' && <AudioCard item={item} contextMenuContent={menu} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} onMarkSeen={onMarkSeen} onDelete={handleDeleteClip} onRecover={handleRecoverClip} />}
                        {item.type === 'script' && <ScriptCard item={item} contextMenuContent={menu} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} onMarkSeen={onMarkSeen} onDelete={handleDeleteClip} onRecover={handleRecoverClip} />}
                        {item.type === 'plan' && <PlanCard item={item} contextMenuContent={menu} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} onMarkSeen={onMarkSeen} />}
                      </div>
                    );
                  })}
                  {sortOrder === 'oldest' && imageGhosts.map((g) => (
                    <div key={g.id} className="w-full">
                      <GhostClipCard id={g.id} type="image" prompt={g.prompt} startedAt={g.startedAt} />
                    </div>
                  ))}
                  <UploadSlot onClick={triggerUpload} />
                </div>
              )}
            </CollapsibleSidebar>

            {/* Center Stage */}
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className={`flex-1 ${planCenterStageOpen ? 'p-0' : 'p-4'} overflow-hidden flex flex-col`}>
                {settingsOpen ? (
                  <ProviderKeysScreen
                    data={providerKeyStatus}
                    loading={providerKeyStatusLoading}
                    error={providerKeyStatusError}
                    saving={envSecretSaving}
                    saveError={envSecretError}
                    onSave={setEnvSecret}
                    onRefresh={() => { void refreshProviderKeyStatus(); }}
                    onClose={() => setSettingsOpen(false)}
                  />
                ) : genPanel != null ? (
                  <GenPreviewPanel
                    key={genPanel.category}
                    ref={genPanelRef}
                    category={genPanel.category}
                    prompt={genPanel.prompt}
                    onClose={() => setGenPanel(null)}
                    callTool={callTool}
                    projectSlug={projectSlug}
                    pendingGeneration={pendingGenForPanel}
                    onGenerationSubmitted={handleGenerationSubmitted}
                  />
                ) : archiveOpen ? (
                  <ArchiveBrowser
                    projectSlug={projectSlug}
                    callTool={callTool}
                    callState={state}
                    initialResponse={archiveInitialResponse}
                    initialError={archiveInitialError}
                    initialLoading={archiveInitialLoading}
                    initialQuery={archiveInitialQuery}
                    onClose={() => setArchiveOpen(false)}
                    onRestoreComplete={handleArchiveRestoreComplete}
                  />
                ) : activeSelection ? (
                  <AssetViewer
                    item={activeSelection}
                    projectSlug={projectSlug ?? ''}
                    size={viewerSize}
                    onSizeChange={handleViewerSizeChange}
                    flipped={viewerFlipped}
                    onFlippedChange={setViewerFlipped}
                    renderOrientation={settingsOrientation}
                    onRender={handleRender}
                    pendingFilePosition={pendingFilePosition}
                    onClearPendingFilePosition={() => setPendingFilePosition(null)}
                    pendingBackTab={pendingBackTab}
                    onClearPendingBackTab={() => setPendingBackTab(null)}
                    settings={renderSettings}
                    onSettingsChange={setRenderSettings}
                    transcript={transcriptInfo}
                    callTool={callTool}
                    callState={state}
                    planResetKey={planOpenKey}
                    onBackToTemplates={openTemplates}
                    onClose={() => setSelectedItem(null)}
                    imageAssets={mediaItems.filter((m) => m.type === 'image' || m.type === 'character')}
                    mediaItems={mediaItems}
                    onEditCharacterProfile={(charId, profile, onProfileSaved) => setCharacterDialog({ initialSlug: charId, initialProfile: profile, onProfileSaved })}
                    cropTarget={cropTarget}
                    onCropConsumed={() => setCropTarget(null)}
                  />
                ) : templatesOpen ? (
                  <TemplatesViewer
                    projectSlug={projectSlug ?? ''}
                    mediaItems={mediaItems}
                    callTool={callTool}
                    onGenerated={handlePlanGenerated}
                    onClose={() => setTemplatesOpen(false)}
                  />
                ) : planEmptyOverride ? (
                  <PlanViewer
                    item={planAssetForOverride}
                    mediaItems={mediaItems}
                    projectSlug={projectSlug ?? ''}
                    callTool={callTool}
                    resetKey={planOpenKey}
                    onClose={() => setPlanEmptyOverride(false)}
                    onBackToTemplates={openTemplates}
                  />
                ) : timelineSlotIndex != null ? (
                  <TimelinePlayer
                    previewData={previewData}
                    initialSlotIndex={timelineSlotIndex}
                    onFrameUpdate={handleFrameUpdate}
                    onOrientationChange={handleViewerSizeChange}
                  />
                ) : (
                  <IdleScreen label="WAITING FOR INPUT" fillParent />
                )}
              </div>
              <div className="shrink-0 px-4 pb-3 pt-2">
                <ChatInput
                  ref={chatInputRef}
                  assetSlugs={assetSlugs}
                  slotRefs={slotRefs}
                  callTool={callTool}
                  projectSlug={projectSlug}
                />
              </div>
            </div>

            {/* Right Sidebar — Clips */}
            <CollapsibleSidebar
              side="right"
              collapsed={rightCollapsed}
              onToggle={() => setRightCollapsed(c => !c)}
              expandedWidth="240px"
              collapsedWidth="40px"
              padding="px-2 pt-2 pb-2"
              gap="gap-0"
            >
              <SidebarHeader
                icon={<Grid3x3 className="w-3.5 h-3.5" />}
                title="Clips"
                collapsed={rightCollapsed}
                onToggle={() => setRightCollapsed(c => !c)}
                side="right"
                sortOrder={sortOrder}
                onSortChange={() => setSortOrder(s => s === 'newest' ? 'oldest' : 'newest')}
              />
              {rightCollapsed ? (
                <div className="flex flex-col items-center gap-2.5 overflow-y-auto flex-1 py-2">
                  {clips.map(item => (
                    <SidebarMicroThumb key={item.id} item={item} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} />
                  ))}
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto space-y-2 mt-2 pr-2">
                  {sortOrder === 'newest' && videoGhosts.map((g) => (
                    <div key={g.id} className="w-full">
                      <GhostClipCard id={g.id} type="video" prompt={g.prompt} startedAt={g.startedAt} />
                    </div>
                  ))}
                  {clips.map((item) => {
                    const isUnseen = item.seenAt == null && (item.status ?? 'ready') === 'ready';
                    const onMarkSeen = isUnseen && projectSlug ? () => handleMarkSeen(item.id) : undefined;
                    const canProjectExport = !!projectSlug && projects.some((p) => p.slug !== projectSlug);
                    const menu = (
                      <AssetMenu
                        slug={item.slug}
                        filePath={item.filePath}
                        itemType={item.type}
                        onAnimateCommand={handleAnimateCommand}
                        onAnimateEdit={handleAnimateEdit}
                        onMarkSeen={onMarkSeen}
                        onOpenProjectExport={canProjectExport ? () => setProjectExportAssetId(item.id) : undefined}
                        MenuItem={ContextMenuItem}
                      />
                    );
                    return (
                      <div key={item.id} className="w-full">
                        {item.type === 'video' && <VideoCard item={item} contextMenuContent={menu} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} onMarkSeen={onMarkSeen} onDelete={handleDeleteClip} onRecover={handleRecoverClip} onAudioDropped={(audioId, audioSlug) => handleAudioDroppedOnVideo(item, audioId, audioSlug)} />}
                        {item.type === 'final' && <FinalVideoCard item={item} contextMenuContent={menu} selected={selectedItem?.id === item.id} onClick={() => handleSelectItem(item)} onMarkSeen={onMarkSeen} onDelete={handleDeleteClip} onRecover={handleRecoverClip} />}
                      </div>
                    );
                  })}
                  {sortOrder === 'oldest' && videoGhosts.map((g) => (
                    <div key={g.id} className="w-full">
                      <GhostClipCard id={g.id} type="video" prompt={g.prompt} startedAt={g.startedAt} />
                    </div>
                  ))}
                  <UploadSlot onClick={triggerUpload} />
                </div>
              )}
            </CollapsibleSidebar>
          </div>

          {/* Timeline */}
          <div className="border-t border-border bg-card/30 overflow-visible">
            <div className="relative h-28 flex gap-1 p-1 overflow-visible">
              {slotRefs.map((slotRef, i) => {
                const slotSlug = timeline?.slots?.[i]?.slug;
                const slotAsset = slotSlug ? mediaItems.find(m => m.id === slotSlug) : null;
                const orientKey = `${settingsOrientation}_frames`;
                const frameUrls = slotAsset?.frameDirs?.[orientKey]
                  ?? slotAsset?.frameDirs?.['original_frames']
                  ?? undefined;
                return (
                  <TimelineSlot
                    key={slotRef.ref}
                    label={slotRef.ref}
                    isActive={timelineSlotIndex === i}
                    hasContent={!!slotSlug}
                    frameUrls={frameUrls}
                    waveform={slotAsset?.waveform ?? undefined}
                    duration={slotAsset?.duration ?? undefined}
                    assetId={slotSlug ? `@${slotSlug}` : undefined}
                    renderStatus={slotAsset?.status}
                    onClick={() => slotSlug && handleSlotClick(i)}
                    onAnimateCommand={handleAnimateCommand}
                  />
                );
              })}
            </div>
            {projectSlug && previewData.ready && (
              <TimelineAudioLane
                audioClips={timeline?.audio ?? []}
                mediaItems={mediaItems}
                slotBoundaries={slotBoundaries}
                totalDurationInFrames={previewData.totalDurationInFrames}
                onAdd={(assetId, startFrame, durationFrames) => { addAudio(projectSlug, assetId, startFrame, durationFrames); }}
                onMove={(audioId, startFrame) => { moveAudio(projectSlug, audioId, startFrame); }}
                onRemove={(audioId) => { removeAudio(projectSlug, audioId); }}
                onUpdate={(audioId, fields) => { updateAudio(projectSlug, audioId, fields); }}
              />
            )}
            <div className="relative h-12 border-t border-border/30 bg-card/20 flex items-center px-3 gap-3">
              {timelineSlotIndex != null && previewData.ready && (
                <>
                  {/* Progress bar with slot boundaries */}
                  <div className="flex-1 relative h-2 bg-white/5 rounded-full overflow-hidden">
                    {/* Slot boundary markers */}
                    {previewData.slotOffsets.slice(1).map((offset, i) => (
                      <div
                        key={i}
                        className="absolute top-0 bottom-0 w-px bg-white/20"
                        style={{ left: `${(offset / previewData.totalDurationInFrames) * 100}%` }}
                      />
                    ))}
                    {/* Progress fill */}
                    <div
                      className="absolute top-0 left-0 bottom-0 bg-primary/60 rounded-full transition-[width] duration-75"
                      style={{ width: `${(currentFrame / previewData.totalDurationInFrames) * 100}%` }}
                    />
                  </div>
                  {/* Time readout */}
                  <span className="text-[10px] font-mono text-muted-foreground/50 tabular-nums whitespace-nowrap">
                    {formatTime(currentFrame / previewData.fps)} / {formatTime(previewData.totalDurationInFrames / previewData.fps)}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <CharacterDialog
        open={!!characterDialog}
        onOpenChange={(next) => { if (!next) setCharacterDialog(null); }}
        imageAssets={mediaItems.filter((m) => m.type === 'image' || m.type === 'character')}
        projectSlug={projectSlug}
        initialSlug={characterDialog?.initialSlug ?? null}
        initialProfile={characterDialog?.initialProfile ?? null}
        generate={generateCharacter}
        submitting={characterSubmitting}
        callTool={callTool}
        callState={state}
        onProfileSaved={characterDialog?.onProfileSaved}
      />
      <PostComposerDialog
        open={!!postPanel}
        onOpenChange={(next) => { if (!next) setPostPanel(null); }}
        item={postPanel?.assetId ? mediaItems.find((m) => m.id === postPanel.assetId) ?? null : null}
        initialText={postPanel?.text ?? ''}
        projectSlug={projectSlug}
        callTool={callTool}
      />
      <ProjectExportPicker
        assetId={projectExportAssetId}
        projectSlug={projectSlug}
        projects={projects}
        callTool={callTool}
        onClose={() => setProjectExportAssetId(null)}
        onAfterExport={() => { void refreshProjects(); }}
      />
      {deleteProjectTarget && (
        <div
          className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm flex items-center justify-center"
          onClick={() => { if (!deleteProjectSubmitting) setDeleteProjectTarget(null); }}
        >
          <div
            className="w-[360px] max-w-[90vw] bg-zinc-950 border border-red-400/40 rounded p-4 shadow-[0_0_24px_rgba(248,113,113,0.25)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[10px] font-mono font-bold tracking-widest text-red-400 mb-2">DELETE PROJECT?</div>
            <div className="text-sm text-zinc-200 mb-3">
              Delete <span className="font-mono text-red-300">{deleteProjectTarget}</span> and all of its assets?
            </div>
            <div className="text-[11px] text-zinc-400 mb-4">
              {formatAssetCount(deleteProjectAssetCount)} will be removed. This cannot be undone.
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={deleteProjectSubmitting}
                onClick={() => setDeleteProjectTarget(null)}
                className="px-3 py-1.5 text-xs font-mono tracking-widest border border-zinc-700 text-zinc-300 hover:bg-zinc-800 rounded disabled:opacity-50"
              >CANCEL</button>
              <button
                type="button"
                disabled={deleteProjectSubmitting}
                onClick={() => { void handleConfirmDeleteProject(); }}
                className="px-3 py-1.5 text-xs font-mono tracking-widest border border-red-400 bg-red-500/15 text-red-300 hover:bg-red-500/25 rounded disabled:opacity-50"
              >{deleteProjectSubmitting ? 'DELETING…' : 'DELETE'}</button>
            </div>
          </div>
        </div>
      )}
      {audioReplace && (
        <div
          className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-sm flex items-center justify-center"
          onClick={() => { if (!audioReplaceSubmitting) setAudioReplace(null); }}
        >
          <div
            className="w-[360px] max-w-[90vw] bg-zinc-950 border border-amber-400/40 rounded p-4 shadow-[0_0_24px_rgba(251,191,36,0.25)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[10px] font-mono font-bold tracking-widest text-amber-400 mb-2">REPLACE AUDIO?</div>
            <div className="text-sm text-zinc-200 mb-3">
              Replace the audio on <span className="font-mono text-amber-300">{audioReplace.videoSlug}</span> with <span className="font-mono text-amber-300">{audioReplace.audioSlug}</span>?
            </div>
            <div className="text-[11px] text-zinc-400 mb-4">The video file will be rewritten in place. Existing per-orientation renders become stale and need to be re-rendered.</div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={audioReplaceSubmitting}
                onClick={() => setAudioReplace(null)}
                className="px-3 py-1.5 text-xs font-mono tracking-widest border border-zinc-700 text-zinc-300 hover:bg-zinc-800 rounded disabled:opacity-50"
              >CANCEL</button>
              <button
                type="button"
                disabled={audioReplaceSubmitting}
                onClick={handleConfirmAudioReplace}
                className="px-3 py-1.5 text-xs font-mono tracking-widest border border-amber-400 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 rounded disabled:opacity-50"
              >{audioReplaceSubmitting ? 'REPLACING…' : 'REPLACE'}</button>
            </div>
          </div>
        </div>
      )}
    </CommandRegistryProvider>
    </MountKeyProvider>
  );
}
