import type { BookManager, ManagedBook } from "../book-manager.js";
import { controlBookSlug, writeSchedule } from "./ledger.js";
import type { TrendingSchedule } from "./types.js";

const pending = new WeakMap<BookManager, Promise<unknown>>();

export async function ensureControlBook(books: BookManager, schedule: TrendingSchedule): Promise<ManagedBook> {
  const next = (pending.get(books) ?? Promise.resolve()).then(async () => {
    await books.ready();
    const slug = controlBookSlug(schedule.country);
    let selected = books.getByName(slug);
    if (!selected.ok) {
      const created = await books.create(slug);
      if (!created.ok) throw new Error(created.error.message);
      selected = books.getByName(slug);
    }
    if (!selected.ok) throw new Error(selected.error.message);
    await writeSchedule(selected.value.engine, schedule);
    return selected.value;
  });
  pending.set(books, next.catch(() => {}));
  return next;
}
