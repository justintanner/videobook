const secretKeys = [
  'OPENAI_API_KEY',
  'KIE_API_KEY',
  'XAI_API_KEY',
  'X_CLIENT_ID',
  'X_CLIENT_SECRET',
  'KIMI_CODING_API_KEY',
  'FAL_API_KEY',
  'DASHSCOPE_API_KEY',
  'GOOGLE_FLOW_API_KEY',
  'ELEVENLABS_API_KEY',
  'B2_ACCESS_KEY_ID',
  'B2_SECRET_ACCESS_KEY',
  'B2_REGION',
  'B2_BUCKET',
  'B2_ENDPOINT',
]

const resolvedCount = secretKeys.filter((key) => {
  const value = process.env[key]
  return value !== undefined && !value.startsWith('op://')
}).length

console.log(`1Password OK - ${resolvedCount} secrets resolved`)
