import type { ActionInputSchema, WorkspaceAction } from '../../server/src/workspace-action-contract'
import { parseCommandArgs } from '../lib/command-registry'

type Params = Parameters<typeof parseCommandArgs>[1]

export type CommandPlanEditor = {
  command: string
  values: Record<string, unknown>
  error?: string
}

const EDITABLE_PLAN_COMMANDS = new Set(['/caption', '/duck', '/fit', '/gap', '/insert', '/move', '/overwrite', '/clip-audio', '/export'])

const clip = { name: 'clip_id', type: 'string', required: true, description: 'Sequence clip' } as const

const CLIP_VERB_PARAMS: Readonly<Record<string, Params>> = {
  '/trim': [clip, { name: 'start_frame', type: 'number', required: true, description: 'Start frame in the sequence' }, { name: 'duration_frames', type: 'number', required: true, description: 'Duration in frames' }],
  '/split': [clip, { name: 'sequence_frame', type: 'number', required: true, description: 'Frame where the clip splits' }],
  '/delete': [clip, { name: 'ripple', type: 'boolean', required: false, description: 'Close the gap the clip leaves' }],
  '/reverse': [clip],
  '/crop': [clip],
}

function schemaFromParams(params: Params): ActionInputSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(params.map((param) => [param.name, {
      type: param.type === 'number' && /_frames?$/u.test(param.name) ? 'integer' : param.type === 'string[]' ? 'array' : param.type,
      description: param.description,
    }])),
    required: params.filter((param) => param.required).map((param) => param.name),
  }
}

export function commandPlanEditorSchema(editor: CommandPlanEditor, action: WorkspaceAction | undefined): ActionInputSchema | null {
  const params = CLIP_VERB_PARAMS[editor.command]
  if (params) return schemaFromParams(params)
  return action?.inputSchema ?? null
}

function flagValue(parts: readonly string[], flag: string): string | undefined {
  const index = parts.findIndex((part) => part.toLowerCase() === flag)
  return index >= 0 ? parts[index + 1] : undefined
}

export function commandPlanEditor(command: string, params: Params, parts: readonly string[]): CommandPlanEditor | undefined {
  const clipParams = CLIP_VERB_PARAMS[command]
  if (clipParams) {
    const ripple = parts.some((part) => part.toLowerCase() === '--ripple')
    const values = parseCommandArgs(parts.filter((part) => part.toLowerCase() !== '--ripple').join(' '), clipParams)
    return { command, values: command === '/delete' ? { ...values, ripple } : values }
  }
  if (!EDITABLE_PLAN_COMMANDS.has(command)) return undefined
  if (command === '/export') {
    return { command, values: { aspect: flagValue(parts, '--aspect') ?? '16:9', captions: flagValue(parts, '--captions') ?? 'burned' } }
  }
  try {
    return { command, values: parseCommandArgs(parts.join(' '), params) }
  } catch {
    return { command, values: {} }
  }
}

export function commandPlanEditorInput(editor: CommandPlanEditor, schema: ActionInputSchema): string {
  if (editor.command === '/export') {
    return `/export --aspect ${String(editor.values.aspect ?? '16:9')} --captions ${String(editor.values.captions ?? 'burned')}`
  }
  const args = Object.keys(schema.properties ?? {})
    .map((name) => name === 'ripple' ? (editor.values.ripple === true ? '--ripple' : undefined) : editor.values[name])
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => Array.isArray(value) ? value.join(' ') : String(value))
  return [editor.command, ...args].join(' ')
}
