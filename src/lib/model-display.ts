const MODEL_DISPLAY: Record<string, Record<string, string>> = {
  kie: {
    'nano-banana': 'Nano Banana',
    'nano-banana-pro': 'Nano Banana Pro',
    'qwen2/image-edit': 'Qwen2 Image Edit',
    'gpt-image-2-image-to-image': 'GPT Image 2',
    'gpt-image-2-text-to-image': 'GPT Image 2',
    'wan/2-7-image': 'Wan 2.7',
    'wan/2-7-image-pro': 'Wan 2.7 Pro',
    'seedream/5-lite-image-to-image': 'Seedream 5 Lite',
    'grok-imagine/text-to-image': 'Grok Imagine',
    'grok-imagine/text-to-video': 'Kie Grok Imagine 1.5',
    'grok-imagine/image-to-video': 'Kie Grok Imagine 1.5',
    'grok-imagine-video-1-5-preview': 'Kie Grok Imagine 1.5',
    'grok-imagine/extend': 'Kie Grok Imagine 1.5',
    'kling-3.0/video': 'Kling 3.0',
    'bytedance/seedance-2': 'Seedance 2',
    'wan/2-7-image-to-video': 'Wan 2.7',
    'wan/2-7-videoedit': 'Wan 2.7 Edit',
    'wan/2-7-r2v': 'Wan 2.7',
  },
  alibaba: {
    'wan2.7-image-pro': 'Wan 2.7 Pro',
    'qwen-image-2.0': 'Qwen Image 2.0',
    'qwen-image-edit': 'Qwen Image Edit',
  },
  google: {
    'veo-3.1-quality': 'Veo 3.1',
    'veo-3.1-fast': 'Veo 3.1 Fast',
    'veo-3.1-lite': 'Veo 3.1 Lite',
    'veo-3.1-lite-low-priority': 'Veo 3.1 Lite LP',
    'omni-flash': 'Gemini Omni Video',
    'nano-banana-pro': 'Nano Banana Pro',
  },
}

export function modelDisplay(provider: string, model: string): string {
  return MODEL_DISPLAY[provider]?.[model] ?? model
}
