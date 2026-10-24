import { asString, recordValue } from './value-decoders'

export type GenerationHarCall = (
  tool: string,
  args: Record<string, unknown>,
  options?: { background?: boolean },
) => Promise<unknown>

export type GenerationHarFile = {
  filename: string
  text: string
}

export async function fetchGenerationHar(
  call: GenerationHarCall,
  bookId: string,
  generationId: string,
): Promise<GenerationHarFile> {
  const result = recordValue(await call(
    'get_generation_har',
    { book_id: bookId, generation_id: generationId },
    { background: true },
  ))
  const har = recordValue(result?.har)
  if (!har) throw new Error('No HAR capture for this attempt')
  return {
    filename: asString(result?.filename) || `videobook-generation-${generationId}.har`,
    text: `${JSON.stringify(har, null, 2)}\n`,
  }
}

export function saveGenerationHar(file: GenerationHarFile): void {
  const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = file.filename
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
