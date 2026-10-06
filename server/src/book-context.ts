import { AsyncLocalStorage } from "node:async_hooks";
import type { Engine } from "videobook-engine";

interface BookContext {
  bookId: string;
  engine: Engine;
  operation?: string;
  artifactId?: string;
}

const contexts = new AsyncLocalStorage<BookContext>();

export function currentBookContext(): BookContext | undefined {
  return contexts.getStore();
}

function activeBookContext(): BookContext {
  const context = contexts.getStore();
  if (!context) throw new Error("A book context is required for this operation");
  return context;
}

export function activeBookEngine(): Engine {
  return activeBookContext().engine;
}

/**
 * Tool and job code often holds `scopedBookEngine` rather than a concrete
 * engine. Storing that proxy as a context's engine would make every property
 * read resolve back to itself, so nested contexts inherit the enclosing book's
 * concrete engine instead.
 */
function concreteEngine(engine: Engine): Engine {
  return engine === scopedBookEngine ? activeBookEngine() : engine;
}

export async function withBookContext<T>(
  context: BookContext,
  operation: () => Promise<T>,
): Promise<T> {
  return contexts.run(
    { ...context, engine: concreteEngine(context.engine) },
    operation,
  );
}

export const scopedBookEngine = new Proxy({} as Engine, {
  get(_target, property) {
    return Reflect.get(activeBookEngine(), property);
  },
});
