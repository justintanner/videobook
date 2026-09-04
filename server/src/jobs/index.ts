import type { Engine } from "videobook-engine";
import type { BookManager } from "../book-manager.js";
import { bookManager } from "../engine.js";

interface PendingRegistration {
  engine: Engine;
  books: BookManager;
}

let pending: PendingRegistration | null = null;
let loadPromise: Promise<void> | null = null;

export function registerAllJobHandlers(
  engine: Engine,
  books: BookManager = bookManager,
): void {
  pending = { engine, books };
  loadPromise = null;
}

export function ensureJobHandlersLoaded(): Promise<void> {
  if (!pending) return Promise.resolve();
  if (!loadPromise) {
    const registration = pending;
    loadPromise = import("./register-all.js").then((mod) => {
      mod.registerAllJobHandlers(registration.engine, registration.books);
    });
  }
  return loadPromise;
}
