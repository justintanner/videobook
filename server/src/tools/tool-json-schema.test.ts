import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestClient } from "../test-client.js";
import { compactJsonSchema, toolInputJsonSchema } from "./tool-json-schema.js";

type TextContent = Array<{ type: string; text: string }>;

describe("compact tool JSON Schemas", () => {
  let client: Client;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-tool-json-schema-"));
    client = await createTestClient(root);
  });

  afterEach(async () => {
    await client?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  it("lists tools without dialect URIs, format regexes or safe-integer bounds", async () => {
    const { tools } = await client.listTools();
    const listed = JSON.stringify(tools);

    expect(tools.length).toBeGreaterThan(100);
    expect(listed).not.toContain("$schema");
    expect(listed).not.toContain("[0-9a-fA-F]{8}");
    expect(listed).not.toContain(String(Number.MAX_SAFE_INTEGER));
    const getNotebook = tools.find((tool) => tool.name === "get_notebook");
    expect(getNotebook?.inputSchema).toEqual({
      type: "object",
      properties: {
        book_id: { type: "string", format: "uuid" },
        notebook_id: { type: "string", format: "uuid" },
      },
      required: ["book_id", "notebook_id"],
    });
  });

  it("still validates the formats and bounds it no longer advertises", async () => {
    const malformed = await client.callTool({
      name: "get_notebook",
      arguments: { book_id: "not-a-uuid", notebook_id: "also-not-a-uuid" },
    });
    expect(malformed.isError).toBe(true);
    expect((malformed.content as TextContent)[0]?.text).toMatch(/Input validation error/u);

    const created = await client.callTool({ name: "create_project", arguments: { book_id: "schema-book" } });
    const bookId = (JSON.parse((created.content as TextContent)[0]!.text) as { bookId: string }).bookId;
    const tooLong = await client.callTool({
      name: "list_jobs",
      arguments: { book_id: bookId, limit: Number.MAX_SAFE_INTEGER + 2 },
    });
    expect(tooLong.isError).toBe(true);
    expect((tooLong.content as TextContent)[0]?.text).toMatch(/Input validation error/u);
  });

  it("only removes keywords, never properties that share a keyword's name", () => {
    const schema = toolInputJsonSchema({
      pattern: z.string().regex(/^[a-z]+$/u),
      minimum: z.number().int(),
      labels: z.record(z.enum(["a", "b"]), z.string()),
      ids: z.array(z.uuid()),
    });

    expect(schema).toEqual({
      type: "object",
      properties: {
        pattern: { type: "string", pattern: "^[a-z]+$" },
        minimum: { type: "integer" },
        labels: {
          type: "object",
          propertyNames: { type: "string", enum: ["a", "b"] },
          additionalProperties: { type: "string" },
          required: ["a", "b"],
        },
        ids: { type: "array", items: { type: "string", format: "uuid" } },
      },
      required: ["pattern", "minimum", "labels", "ids"],
    });
  });

  it("leaves schema-shaped values in defaults and enums untouched", () => {
    const value = { $schema: "kept", pattern: "kept", maximum: Number.MAX_SAFE_INTEGER };
    expect(compactJsonSchema({
      type: "object",
      default: value,
      enum: [value],
      properties: { nested: { type: "string", format: "uuid", pattern: "^x$" } },
    })).toEqual({
      type: "object",
      default: value,
      enum: [value],
      properties: { nested: { type: "string", format: "uuid" } },
    });
  });
});
