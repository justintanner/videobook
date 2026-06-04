import { modelDisplay } from '@/lib/model-display';
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
  nano_banana_image:             { model: modelDisplay('kie', 'nano-banana'),                       provider: 'Kie' },
  qwen2_image_edit:              { model: modelDisplay('kie', 'qwen2/image-edit'),                  provider: 'Kie' },
  grok_imagine_image:            { model: modelDisplay('kie', 'grok-imagine/text-to-image'),        provider: 'Kie' },
  grok_imagine_video:            { model: modelDisplay('kie', 'grok-imagine/text-to-video'),        provider: 'Kie' },
  grok_imagine_text:             { model: modelDisplay('kie', 'grok-imagine/text-to-image'),        provider: 'Kie' },
  grok_imagine_extend_video:     { model: modelDisplay('kie', 'grok-imagine/extend'),               provider: 'Kie' },
  gpt_image:                     { model: modelDisplay('kie', 'gpt-image-2-image-to-image'),        provider: 'Kie' },
  gpt_image_text:                { model: modelDisplay('kie', 'gpt-image-2-text-to-image'),         provider: 'Kie' },
  kling30_video:                 { model: modelDisplay('kie', 'kling-3.0/video'),                   provider: 'Kie' },
  seedance2_video:               { model: modelDisplay('kie', 'bytedance/seedance-2'),              provider: 'Kie' },
  wan27_image:                   { model: modelDisplay('kie', 'wan/2-7-image'),                     provider: 'Kie' },
  wan27_image_pro:               { model: modelDisplay('kie', 'wan/2-7-image-pro'),                 provider: 'Kie' },
  wan27_i2v_video:               { model: modelDisplay('kie', 'wan/2-7-image-to-video'),            provider: 'Kie' },
  wan27_videoedit_video:         { model: modelDisplay('kie', 'wan/2-7-videoedit'),                 provider: 'Kie' },
  wan27_r2v_video:               { model: modelDisplay('kie', 'wan/2-7-r2v'),                       provider: 'Kie' },
  xai_grok_imagine_video:        { model: modelDisplay('kie', 'grok-imagine/text-to-video'),        provider: 'xAI' },
  xai_grok_imagine_ref_video:    { model: modelDisplay('kie', 'grok-imagine/image-to-video'),       provider: 'xAI' },
  alibaba_image:                 { model: modelDisplay('alibaba', 'wan2.7-image-pro'),              provider: 'Alibaba' },
  alibaba_image_pro:             { model: modelDisplay('alibaba', 'wan2.7-image-pro'),              provider: 'Alibaba' },
  alibaba_qwen_image:            { model: modelDisplay('alibaba', 'qwen-image-2.0'),                provider: 'Alibaba' },
  alibaba_qwen_image_edit:       { model: modelDisplay('alibaba', 'qwen-image-edit'),               provider: 'Alibaba' },
  alibaba_video:                 { model: modelDisplay('alibaba', 'wan2.7-image-pro'),              provider: 'Alibaba' },
  transcribe:                    { model: 'Whisper',                                                provider: 'OpenAI' },
  isolate_vocals:                { model: 'Vocal Isolation',                                        provider: 'Kie' },
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
