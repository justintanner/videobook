import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestClient } from "../test-client.js";

type TextContent = Array<{ type: string; text: string }>;
type Entity = { id: string; type: string; name: string; prompt?: string; description?: string };

describe("reusable entity tools", () => {
  let client: Client;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-entity-tools-"));
    client = await createTestClient(root);
    await client.callTool({ name: "create_project", arguments: { book_id: "entities" } });
  });

  afterEach(async () => {
    await client?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name, arguments: { book_id: "entities", ...args } });
    const text = (result.content as TextContent)[0]!.text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as T;
  }

  it("creates, lists, reads, updates and deletes every kind through one set of tools", async () => {
    const created = await Promise.all((["prompt", "scene", "character"] as const).map((kind) =>
      call<Entity>("create_entity", { kind, name: `${kind} one`, prompt: `${kind} prompt` })));
    expect(created.map((entity) => entity.type)).toEqual(["prompt", "scene", "character"]);

    expect((await call<Entity[]>("list_entities", {})).map((entity) => entity.name).sort())
      .toEqual(["character one", "prompt one", "scene one"]);
    expect((await call<Entity[]>("list_entities", { kind: "scene" })).map((entity) => entity.id))
      .toEqual([created[1]!.id]);

    for (const entity of created) {
      const read = await call<Entity>("get_entity", { entity_id: entity.id });
      expect(read).toMatchObject({ id: entity.id, type: entity.type, prompt: `${entity.type} prompt` });
      await call("update_entity", { entity: { ...read, prompt: `${entity.type} revised`, description: "kept" } });
      expect(await call<Entity>("get_entity", { entity_id: entity.id }))
        .toMatchObject({ id: entity.id, type: entity.type, prompt: `${entity.type} revised`, description: "kept" });
    }

    await call("delete_entity", { entity_id: created[0]!.id });
    expect((await call<Entity[]>("list_entities", {})).map((entity) => entity.type).sort())
      .toEqual(["character", "scene"]);
    await expect(call("get_entity", { entity_id: created[0]!.id })).rejects.toThrow();
  });

  it("rejects unknown kinds", async () => {
    await expect(call("create_entity", { kind: "location", name: "Nowhere" })).rejects.toThrow(/Input validation error/u);
  });
});
