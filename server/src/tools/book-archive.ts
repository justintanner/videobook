import { z } from "zod";
import { BOOK_AUTOMATION_PAUSED_KEY } from "videobook-engine";
import type { BookManager } from "../book-manager.js";
import { queue } from "../queue.js";
import { loadAndArmAll } from "../scheduled-posts.js";
import type { ToolDef } from "./tool-def.js";

export function bookArchiveDefs(books: BookManager): ToolDef[] {
  return [{
    name: "book_archive",
    scope: "global",
    recordsOwnActivity: true,
    description: "Local export-book/import-book CLI coordination: prepare a consistent snapshot, reserve an import workspace, adopt a validated book, or release scratch files. Archive bytes stay on the local filesystem.",
    schema: {
      op: z.enum(["snapshot", "prepare_import", "commit_import", "release"]),
      book: z.string().optional(),
      book_id: z.string().uuid().optional(),
      name: z.string().optional(),
      created_at: z.number().int().optional(),
      head: z.string().optional(),
      token: z.string().uuid().optional(),
      client_pid: z.number().int().positive().optional(),
    },
    handler: async (args) => {
      try {
        const result = await queue.maintenance(async () => {
          if (args.op === "snapshot") {
            if (typeof args.book !== "string") throw new Error("book is required");
            return books.prepareExport(args.book, typeof args.client_pid === "number" ? args.client_pid : undefined);
          }
          if (args.op === "prepare_import") {
            if (typeof args.book_id !== "string" || typeof args.name !== "string" || typeof args.created_at !== "number"
              || typeof args.head !== "string") throw new Error("Archive identity and head are required");
            return books.prepareImport({ bookId: args.book_id, name: args.name, createdAt: args.created_at }, args.head,
              typeof args.client_pid === "number" ? args.client_pid : undefined);
          }
          if (typeof args.token !== "string") throw new Error("token is required");
          if (args.op === "commit_import") return books.commitImport(args.token);
          await books.releaseArchive(args.token);
          return { released: true };
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  }, {
    name: "set_book_automation",
    scope: "global",
    description: "Pause or explicitly resume a book's automatic publishing, research and metrics schedules. Imported books start paused; schedule configuration and history are preserved.",
    schema: { book_id: z.string().uuid(), paused: z.boolean() },
    handler: async (args) => {
      const book = await books.ensure(String(args.book_id));
      if (!book.ok) return { isError: true, content: [{ type: "text", text: book.error.message }] };
      const result = book.value.engine.settings.set(BOOK_AUTOMATION_PAUSED_KEY, args.paused === true);
      if (!result.ok) return { isError: true, content: [{ type: "text", text: result.error.message }] };
      if (args.paused === false) await loadAndArmAll(String(args.book_id));
      return { content: [{ type: "text", text: JSON.stringify({ book_id: args.book_id, paused: args.paused }) }] };
    },
  }];
}
