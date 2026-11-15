import { setTimeout as delay } from 'node:timers/promises'
import { testBudget } from '../../server/src/test-budget.js'
import { seedMixedStatusCatalog } from './library-browse-fixture.js'

const { DoltStore } = await import(new URL('./store.js', import.meta.resolve('videobook-engine')).href)
let transactions = 0
const runtime = DoltStore.prototype.runtime
DoltStore.prototype.runtime = function (mutate) {
  transactions += 1
  return runtime.call(this, mutate)
}

const { bookManager } = await import('../../server/src/engine.js')
const { startServer } = await import('../../server/src/serve.js')
await bookManager.ready()
for (let index = 0; index < 4; index += 1) {
  const created = await bookManager.create(`idle-${index}`)
  if (!created.ok) throw new Error(created.error.message)
  const selected = bookManager.get(created.value.bookId)
  if (!selected.ok) throw new Error(selected.error.message)
  await seedMixedStatusCatalog(selected.value.engine, { ready: 3, error: 0, processing: 0 })
}

const server = await startServer({ port: 0, ui: false })
try {
  await server.ready
  await delay(testBudget(1_000))
  const startupTransactions = transactions
  transactions = 0
  await delay(testBudget(1_000))
  console.log(`IDLE_RESULT ${JSON.stringify({ books: bookManager.list().length, startupTransactions, idleTransactions: transactions })}`)
} finally {
  await server.close()
  DoltStore.prototype.runtime = runtime
}
