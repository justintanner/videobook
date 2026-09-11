import type { Engine } from "videobook-engine";
import { z } from "zod";
import { uploadLocalBytes } from "../local-upload.js";
import type { ToolDef } from "./tool-def.js";

function isBase64Upload(value: string): boolean {
  const normalized = value.replace(/\s/gu, "");
  const match = /^([A-Za-z0-9+/_-]*)(={0,2})$/u.exec(normalized);
  return match !== null
    && match[1].length % 4 !== 1
    && (match[2].length === 0 || normalized.length % 4 === 0);
}

export function uploadFileDef(engine: Engine): ToolDef {
  return {
    name: "upload_file",
    description: "Upload a media or markdown file into a Videobook project as an asset",
    schema: {
      book_id: z.string().describe("Book id to upload into"),
      filename: z.string().describe("Original filename with extension"),
      data: z.string().refine(isBase64Upload, "File contents must be valid base64").describe("Base64-encoded file contents"),
    },
    handler: async (args) => {
      const { book_id, filename, data } = args as { book_id: string; filename: string; data: string };
      const result = await uploadLocalBytes(engine, {
        bookId: book_id,
        filename,
        data: Buffer.from(data, "base64"),
        waitForProcessing: true,
      });

      if (!result.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: result.message }],
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result.value),
        }],
      };
    },
  };
}
