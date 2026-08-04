export interface ProviderPromptLeak {
  token: string
  code: string
  message: string
}

export interface ProviderUrlPlaceholder {
  path: string
  reference: string
  url: string
}

export interface ProviderPayloadPreviewMentions {
  promptLeaks: ProviderPromptLeak[]
  urlPlaceholders: ProviderUrlPlaceholder[]
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function providerPayloadPreviewMentions(
  value: unknown,
): ProviderPayloadPreviewMentions {
  const root = recordValue(value)
  const mentions = recordValue(root?.mentions)
  const promptLeaks = Array.isArray(mentions?.prompt_leaks)
    ? mentions.prompt_leaks.flatMap((entry) => {
        const item = recordValue(entry)
        const token = stringValue(item?.token)
        const code = stringValue(item?.code)
        const message = stringValue(item?.message)
        return token && code && message ? [{ token, code, message }] : []
      })
    : []
  const urlPlaceholders = Array.isArray(mentions?.url_placeholders)
    ? mentions.url_placeholders.flatMap((entry) => {
        const item = recordValue(entry)
        const path = stringValue(item?.path)
        const reference = stringValue(item?.reference)
        const url = stringValue(item?.url)
        return path && reference && url ? [{ path, reference, url }] : []
      })
    : []
  return { promptLeaks, urlPlaceholders }
}
