import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHarCapture, type HarCallMeta } from "@apicity/har";
import { currentBookContext } from "./book-context.js";
import { harDirectory, readHarSettings } from "./har-settings.js";
import { logger } from "./logger.js";

const pending = new Set<Promise<void>>();
let maintenance: Promise<void> = Promise.resolve();

export async function maintainHarCaptures(operation: () => Promise<void>): Promise<boolean> {
  if (pending.size) return false;
  const next = maintenance.then(operation);
  maintenance = next.catch(() => undefined);
  await next;
  return true;
}

export async function flushHarCaptures(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

function captureInput(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Blob) return { _file: { size: value.size, contentType: value.type } };
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { _apicity_placeholder: { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") } };
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof FormData) return Object.fromEntries(Array.from(value.entries(), ([key, entry]) => [key, captureInput(entry, seen)]));
  if (Array.isArray(value)) return value.map((entry) => captureInput(entry, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === "otp" ? "***" : captureInput(entry, seen)]));
}

export async function withHarCapture<T>(
  meta: HarCallMeta,
  operation: (fetch: typeof globalThis.fetch) => T | Promise<T>,
  base: typeof globalThis.fetch = globalThis.fetch,
  context: Record<string, unknown> = {},
): Promise<T> {
  for (;;) {
    const barrier = maintenance;
    await barrier;
    if (barrier === maintenance) break;
  }
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  pending.add(finished);
  try {
    return await runCapture(meta, operation, base, context);
  } finally {
    finish();
    pending.delete(finished);
  }
}

async function runCapture<T>(meta: HarCallMeta, operation: (fetch: typeof globalThis.fetch) => T | Promise<T>, base: typeof globalThis.fetch, context: Record<string, unknown>): Promise<T> {
  const settings = await readHarSettings();
  if (settings.mode === "off") return operation(base);
  let input: unknown;
  try { input = captureInput(meta.input); }
  catch (error) {
    logger.warn("har-capture-failed", { error });
    return operation(base);
  }
  const book = currentBookContext();
  const capture = createHarCapture({
    dir: harDirectory(),
    mode: settings.mode,
    context: {
      bookId: book?.bookId,
      operation: book?.operation,
      artifactId: book?.artifactId,
      attemptId: book?.attemptId ?? book?.artifactId,
      providerTaskId: book?.providerTaskId,
      runId: book?.runId,
      model: book?.model,
      ...context,
    },
    onError: (error) => logger.warn("har-capture-failed", { error }),
  });
  const host = { fetch: base };
  capture.install(host);
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const done = finished.then(() => capture.close());
  pending.add(done);
  void done.finally(() => pending.delete(done));
  try {
    return await capture.call({ ...meta, input }, () => operation(host.fetch));
  } finally {
    finish();
  }
}

const HTTP_METHODS: ReadonlySet<string> = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function endpointDotPath(path: readonly string[]): string {
  return (path.length > 1 && HTTP_METHODS.has(path[0] ?? "") ? path.slice(1) : path).join(".");
}

const providerCalls = new WeakMap<object, {
  original: object;
  base: typeof globalThis.fetch;
  transports: AsyncLocalStorage<typeof globalThis.fetch>;
}>();

export function withProviderCall<P extends object, T>(provider: P, meta: HarCallMeta, operation: (original: P) => Promise<T>): Promise<T> {
  const state = providerCalls.get(provider);
  if (!state) return operation(provider);
  return withHarCapture(meta, (fetch) => state.transports.run(fetch, () => operation(state.original as P)), state.base);
}

export function capturedProvider<T extends object>(
  provider: string,
  factory: (fetch: typeof globalThis.fetch) => T,
  base: typeof globalThis.fetch = globalThis.fetch,
): T {
  const transports = new AsyncLocalStorage<typeof globalThis.fetch>();
  const original = factory((input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    return (transports.getStore() ?? base)(input, init);
  });
  function wrap(target: object, path: string[]): object {
    return new Proxy(target, {
      apply(fn, receiver, args: unknown[]) {
        return withHarCapture({ provider, endpoint: endpointDotPath(path), input: args.length === 1 ? args[0] : args },
          (fetch) => transports.run(fetch, () => Reflect.apply(fn as (...values: unknown[]) => unknown, receiver, args)), base);
      },
      get(object, property, receiver): unknown {
        const value: unknown = Reflect.get(object, property, receiver);
        if (typeof target === "function" && ["bind", "call", "apply"].includes(String(property)) && typeof value === "function") return value.bind(receiver);
        if (typeof property !== "string" || ["presign", "schema", "example", "examples"].includes(property)) return value;
        const next = [...path, property];
        if (typeof value === "function") return wrap(value, next);
        if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return wrap(value, next);
        return value;
      },
    });
  }
  const providerClient = wrap(original, []) as T;
  providerCalls.set(providerClient, { original, base, transports });
  return providerClient;
}
