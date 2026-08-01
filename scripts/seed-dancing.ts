import '../server/src/load-env.js'
import process from 'node:process'
import { resolve } from 'node:path'
import { BookManager } from '../server/src/book-manager.js'
import { ensureDancingWorkflow } from '../server/src/dancing-workflow.js'

const libraryDir = resolve(process.env.VIDEOBOOK_LIBRARY_DIR ?? './runtime/books')
const books = new BookManager({
  libraryDir,
  objectPrefix: 'superlzy-media/videobook/sha256',
  catalogBackupName: 'backup',
})

try {
  const result = await ensureDancingWorkflow(books)
  const selected = books.getBySlug('dancing')
  if (!selected.ok) throw new Error(selected.error.message)
  const notebook = selected.value.engine.notebooks.read(result.notebookId)
  if (!notebook.ok) throw new Error(notebook.error.message)
  process.stdout.write(`${JSON.stringify({
    book: selected.value.slug,
    notebook: notebook.value.name,
    cells: notebook.value.cells.length,
    edges: notebook.value.edges.length,
    status: result.status,
    revision: result.revision,
  }, null, 2)}\n`)
} finally {
  await books.close()
}
