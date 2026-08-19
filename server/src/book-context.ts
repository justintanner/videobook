import { AsyncLocalStorage } from "node:async_hooks";
import type { Engine } from "videobook-engine";

interface BookContext {
  bookId: string;
  engine: Engine;
}

const contexts = new AsyncLocalStorage<BookContext>();

function activeBookContext(): BookContext {
  const context = contexts.getStore();
  if (!context) throw new Error("A book context is required for this operation");
  return context;
}

export function activeBookEngine(): Engine {
  return activeBookContext().engine;
}

export async function withBookContext<T>(
  context: BookContext,
  operation: () => Promise<T>,
): Promise<T> {
  return contexts.run(context, operation);
}

export const scopedBookEngine = new Proxy({} as Engine, {
  get(_target, property) {
    return Reflect.get(activeBookEngine(), property);
  },
});
