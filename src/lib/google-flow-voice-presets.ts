import { GoogleFlowVoicePresetSchema } from '@apicity/googleflow/zod'

export const GOOGLE_FLOW_VOICE_PRESETS = GoogleFlowVoicePresetSchema.options

export type GoogleFlowVoicePreset = (typeof GOOGLE_FLOW_VOICE_PRESETS)[number]
