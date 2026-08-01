export interface ChatModelOption {
  id: string
  label: string
  description: string
}

export interface ChatModelCatalog {
  defaultModel: string
  models: readonly ChatModelOption[]
}

export const fallbackChatModelCatalog: ChatModelCatalog = {
  defaultModel: 'gpt-5.6-sol',
  models: [{
    id: 'gpt-5.6-sol',
    label: 'Sol',
    description: 'Deeper reasoning for complex edits',
  }],
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function asChatModelCatalog(value: unknown): ChatModelCatalog {
  const source = record(value)
  const models = Array.isArray(source?.models)
    ? source.models.flatMap((entry) => {
        const model = record(entry)
        return typeof model?.id === 'string'
          && typeof model.label === 'string'
          && typeof model.description === 'string'
          ? [{
              id: model.id,
              label: model.label,
              description: model.description,
            }]
          : []
      })
    : []
  const requestedDefault = typeof source?.defaultModel === 'string'
    ? source.defaultModel
    : ''
  const defaultModel = models.some((model) => model.id === requestedDefault)
    ? requestedDefault
    : models[0]?.id
  return defaultModel
    ? { defaultModel, models }
    : fallbackChatModelCatalog
}

export function resolveChatModelSelection(
  catalog: ChatModelCatalog,
  selection: string,
): string {
  return catalog.models.some((model) => model.id === selection)
    ? selection
    : catalog.defaultModel
}
