import { nonBlankStringValue, recordValue } from './value-decoders'

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

export function providerPayloadPreviewMentions(
  value: unknown,
): ProviderPayloadPreviewMentions {
  const root = recordValue(value)
  const mentions = recordValue(root?.mentions)
  const promptLeaks = Array.isArray(mentions?.prompt_leaks)
    ? mentions.prompt_leaks.flatMap((entry) => {
        const item = recordValue(entry)
        const token = nonBlankStringValue(item?.token)
        const code = nonBlankStringValue(item?.code)
        const message = nonBlankStringValue(item?.message)
        return token && code && message ? [{ token, code, message }] : []
      })
    : []
  const urlPlaceholders = Array.isArray(mentions?.url_placeholders)
    ? mentions.url_placeholders.flatMap((entry) => {
        const item = recordValue(entry)
        const path = nonBlankStringValue(item?.path)
        const reference = nonBlankStringValue(item?.reference)
        const url = nonBlankStringValue(item?.url)
        return path && reference && url ? [{ path, reference, url }] : []
      })
    : []
  return { promptLeaks, urlPlaceholders }
}
