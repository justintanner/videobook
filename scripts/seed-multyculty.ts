import process from 'node:process'
import { resolve } from 'node:path'
import { BookManager } from '../server/src/book-manager.js'
import { seedMultycultyWorkflow } from '../server/src/multyculty-workflow.js'
import { videobookDomainDefs } from '../server/src/tools/videobook-domain.js'

const libraryDir = resolve(process.env.VIDEOBOOK_LIBRARY_DIR ?? './books')
const books = new BookManager({
  libraryDir,
  objectPrefix: 'videobook-objects',
  catalogBackupName: 'origin',
})

try {
  await books.ready()
  const selected = books.getBySlug('multyculty')
  if (!selected.ok) throw new Error(selected.error.message)
  const notebook = selected.value.engine.notebooks.list()[0]
  if (!notebook) throw new Error('The Multyculty book has no notebook')
  const source = selected.value.engine.artifacts.list().find((artifact) =>
    artifact.slug === 'vid-source-selection')
  if (!source) throw new Error('The Multyculty source fixture is missing')
  const setSpine = videobookDomainDefs(selected.value.engine, books).find((tool) =>
    tool.name === 'set_notebook_audio_spine')
  if (!setSpine) throw new Error('The audio spine tool is unavailable')
  const spineResult = await setSpine.handler({
    book_id: selected.value.bookId,
    notebook_id: notebook.id,
    artifact_id: source.artifactId,
  })
  if (spineResult.isError) {
    throw new Error(spineResult.content[0]?.text ?? 'Could not set the audio spine')
  }
  const seeded = await seedMultycultyWorkflow(selected.value.engine, {
    materializeLocalOutputs: true,
  })
  process.stdout.write(`${JSON.stringify({
    book: selected.value.slug,
    notebook: seeded.name,
    cells: seeded.cells.length,
    edges: seeded.edges.length,
    revision: selected.value.engine.head,
  }, null, 2)}\n`)
} finally {
  await books.close()
}
