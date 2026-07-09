/** Google Flow system voice presets (useapi.net / Omni referenceAudio_*).
 *  Mirror of GoogleFlowVoicePresetSchema in @apicity/googleflow — kept client-side
 *  so the gen panel can offer them without a network round-trip when list fails. */
export const GOOGLE_FLOW_VOICE_PRESETS = [
  'Achernar',
  'Achird',
  'Algenib',
  'Algieba',
  'Alnilam',
  'Aoede',
  'Autonoe',
  'Callirrhoe',
  'Charon',
  'Despina',
  'Enceladus',
  'Erinome',
  'Fenrir',
  'Gacrux',
  'Iapetus',
  'Kore',
  'Laomedeia',
  'Leda',
  'Orus',
  'Puck',
  'Pulcherrima',
  'Rasalgethi',
  'Sadachbia',
  'Sadaltager',
  'Schedar',
  'Sulafat',
  'Umbriel',
  'Vindemiatrix',
  'Zephyr',
  'Zubenelgenubi',
] as const

export type GoogleFlowVoicePreset = (typeof GOOGLE_FLOW_VOICE_PRESETS)[number]
