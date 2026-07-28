import type { PreparedSearchReference } from "videobook-engine";
import { v7 as uuidv7 } from "uuid";

export type SearchReferenceKind = PreparedSearchReference["kind"];

export interface SearchReferenceDescriptor {
  reference_id: string;
  kind: SearchReferenceKind;
  name: string;
  duration_ms?: number;
  expires_at: number;
}

interface StoredSearchReference {
  descriptor: SearchReferenceDescriptor;
  reference: PreparedSearchReference;
}

export class SearchReferenceStore {
  private readonly entries = new Map<string, StoredSearchReference>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 128,
    private readonly now: () => number = Date.now,
  ) {}

  put(input: {
    kind: SearchReferenceKind;
    name: string;
    durationMs?: number;
    reference: PreparedSearchReference;
  }): SearchReferenceDescriptor {
    this.purge();
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
    const referenceId = uuidv7();
    const descriptor: SearchReferenceDescriptor = {
      reference_id: referenceId,
      kind: input.kind,
      name: input.name,
      ...(input.durationMs === undefined
        ? {}
        : { duration_ms: input.durationMs }),
      expires_at: this.now() + this.ttlMs,
    };
    this.entries.set(referenceId, {
      descriptor,
      reference: input.reference,
    });
    return descriptor;
  }

  get(referenceId: string): StoredSearchReference {
    this.purge();
    const entry = this.entries.get(referenceId);
    if (!entry) {
      throw new Error("Search reference expired or was released");
    }
    this.entries.delete(referenceId);
    this.entries.set(referenceId, entry);
    return entry;
  }

  release(referenceId: string): boolean {
    return this.entries.delete(referenceId);
  }

  purge(): void {
    const now = this.now();
    for (const [referenceId, entry] of this.entries) {
      if (entry.descriptor.expires_at <= now) {
        this.entries.delete(referenceId);
      }
    }
  }
}

export const searchReferenceStore = new SearchReferenceStore();
