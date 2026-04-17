import type { MediaItem } from '@/components/sidebar/types';

type Orientation = 'portrait' | 'square' | 'landscape';

export function getCardOrientation(width: number | null | undefined, height: number | null | undefined): Orientation {
  const w = width ?? 1920;
  const h = height ?? 1080;
  if (h > w) return 'portrait';
  if (w === h) return 'square';
  return 'landscape';
}

export function getCardWidthClass(orientation: Orientation): string {
  if (orientation === 'portrait') return 'min-w-[220px] w-[220px]';
  if (orientation === 'square') return 'w-[220px]';
  return 'w-[300px]';
}

export function getRatioLabel(orientation: Orientation): string {
  if (orientation === 'portrait') return '9:16';
  if (orientation === 'square') return '1:1';
  return '16:9';
}

export function getRatioBadgeClasses(orientation: Orientation): string {
  if (orientation === 'portrait') return 'bg-violet-500/15 text-violet-400/80';
  if (orientation === 'square') return 'bg-amber-500/15 text-amber-400/80';
  return 'bg-primary/10 text-primary/60';
}

export function isFailedPending(item: MediaItem): boolean {
  if (item.status === 'error') return true;
  const ps = item.pendingState;
  return ps === 'fail' || ps === 'expired';
}

interface TaskInfo {
  model: string;
  provider: string;
}

const TASK_INFO: Record<string, TaskInfo> = {
  nano_banana_image:             { model: 'Nano Banana',         provider: 'Kie' },
  qwen2_image_edit:              { model: 'Qwen 2 Edit',         provider: 'Kie' },
  grok_imagine_image:            { model: 'Grok Imagine',        provider: 'Kie' },
  grok_imagine_video:            { model: 'Grok Imagine',        provider: 'Kie' },
  grok_imagine_text:             { model: 'Grok Imagine',        provider: 'Kie' },
  grok_imagine_extend_video:     { model: 'Grok Extend',         provider: 'Kie' },
  gpt_image:                     { model: 'GPT Image',           provider: 'Kie' },
  kling30_video:                 { model: 'Kling 3.0',           provider: 'Kie' },
  seedance2_video:                { model: 'Seedance 2',          provider: 'Kie' },
  wan27_image:                   { model: 'WAN 2.7',             provider: 'Kie' },
  wan27_image_pro:               { model: 'WAN 2.7 Pro',         provider: 'Kie' },
  wan27_i2v_video:               { model: 'WAN 2.7 I2V',         provider: 'Kie' },
  wan27_videoedit_video:         { model: 'WAN 2.7 Edit',        provider: 'Kie' },
  wan27_r2v_video:               { model: 'WAN 2.7 R2V',         provider: 'Kie' },
  xai_grok_imagine_video:        { model: 'Grok Imagine',        provider: 'xAI' },
  xai_grok_imagine_ref_video:    { model: 'Grok Imagine Ref',    provider: 'xAI' },
  alibaba_image:                 { model: 'Wan 2.7 Image',       provider: 'Alibaba' },
  alibaba_image_pro:             { model: 'Wan 2.7 Image Pro',   provider: 'Alibaba' },
  alibaba_video:                 { model: 'Wan 2.7 Video',       provider: 'Alibaba' },
  transcribe:                    { model: 'Whisper',             provider: 'OpenAI' },
  isolate_vocals:                { model: 'Vocal Isolation',     provider: 'Kie' },
};

export function getTaskInfo(taskType: string | undefined): TaskInfo {
  if (!taskType) return { model: '—', provider: '—' };
  const info = TASK_INFO[taskType];
  if (info) return info;
  return { model: taskType.replace(/_/g, ' '), provider: '—' };
}

export function getCurrentPhase(item: MediaItem): string {
  if (isFailedPending(item)) return 'failed';
  if (item.status === 'loading') return 'finalizing';
  if (item.status === 'downloading') return 'downloading';
  if (item.pendingState === 'success') return 'downloading';
  if (item.pendingState === 'processing') return 'processing';
  if (item.pendingState === 'queued') return 'queued';
  if (item.status === 'generating') return 'processing';
  return 'queued';
}
