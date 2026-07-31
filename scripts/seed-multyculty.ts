import process from 'node:process'
import { resolve } from 'node:path'
import { BookManager } from '../server/src/book-manager.js'
import {
  bootstrapMultycultySource,
  seedMultycultyWorkflow,
} from '../server/src/multyculty-workflow.js'

const libraryDir = resolve(process.env.VIDEOBOOK_LIBRARY_DIR ?? './books')
const books = new BookManager({
  libraryDir,
  objectPrefix: 'videobook-objects',
  catalogBackupName: 'origin',
})

try {
  await books.ready()
  let selected = books.getBySlug('multyculty')
  if (!selected.ok) {
    const created = await books.create('multyculty')
    if (!created.ok) throw new Error(created.error.message)
    selected = books.getBySlug('multyculty')
    if (!selected.ok) throw new Error(selected.error.message)
  }
  await bootstrapMultycultySource(selected.value.engine)
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
