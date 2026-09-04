import type { CatalogGcReport, Engine } from "videobook-engine";
import type { BookManager } from "./book-manager.js";

export interface BookCatalogGcReport {
  bookId: string;
  name: string;
  bytesBefore: number;
  bytesAfter: number;
  chunksRemoved: number | null;
  chunksKept: number | null;
  summary: string;
}

function bookCatalogGcReport(
  bookId: string,
  name: string,
  report: CatalogGcReport,
): BookCatalogGcReport {
  return {
    bookId,
    name,
    bytesBefore: report.bytesBefore,
    bytesAfter: report.bytesAfter,
    chunksRemoved: report.chunksRemoved,
    chunksKept: report.chunksKept,
    summary: report.summary,
  };
}

export function gcEngineCatalog(engine: Engine): BookCatalogGcReport {
  const book = engine.book.get();
  return bookCatalogGcReport(book.bookId, book.name, engine.gcCatalog());
}

export async function gcLibraryCatalogs(
  books: BookManager,
): Promise<BookCatalogGcReport[]> {
  await books.ready();
  const reports: BookCatalogGcReport[] = [];
  for (const summary of books.list()) {
    const selected = books.get(summary.bookId);
    if (!selected.ok) continue;
    reports.push(gcEngineCatalog(selected.value.engine));
  }
  return reports;
}
