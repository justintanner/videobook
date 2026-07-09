import { describe, it, expect } from "vitest";
import { createGoogleFlow } from "@apicity/googleflow";
import {
  readCharacterThumbnailUrl,
  readCreatedRef,
  readEntityList,
  readGoogleFlowAccountEmails,
  resolveGoogleFlowEmail,
} from "./_google-flow-entities.js";

function jsonProvider(body: unknown, calls?: string[]) {
  const fetchFn: typeof fetch = async (input) => {
    if (calls) calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return createGoogleFlow({ apiKey: "test-token", fetch: fetchFn });
}

describe("readCreatedRef", () => {
  it("reads a bare string ref field", () => {
    expect(readCreatedRef({ voice: "user:1-voice:abc" }, "voice")).toBe("user:1-voice:abc");
    expect(readCreatedRef({ character: "user:1-character:xyz" }, "character")).toBe("user:1-character:xyz");
  });

  it("reads a nested object ref", () => {
    expect(readCreatedRef({ voice: { voice: "nested-ref" } }, "voice")).toBe("nested-ref");
    expect(readCreatedRef({ character: { ref: "by-ref" } }, "character")).toBe("by-ref");
  });

  it("falls back to generic ref/id keys", () => {
    expect(readCreatedRef({ ref: "top-ref" }, "voice")).toBe("top-ref");
    expect(readCreatedRef({ id: "top-id" }, "character")).toBe("top-id");
  });

  it("returns null when no ref is present", () => {
    expect(readCreatedRef({ status: "ok" }, "voice")).toBeNull();
  });
});

describe("readCharacterThumbnailUrl", () => {
  it("prefers thumbnailUrl", () => {
    expect(readCharacterThumbnailUrl({
      thumbnailUrl: "https://example.com/t.jpg",
      imageReferences: [{ previewUrl: "https://example.com/p.jpg" }],
    })).toBe("https://example.com/t.jpg");
  });

  it("falls back to first imageReferences previewUrl", () => {
    expect(readCharacterThumbnailUrl({
      imageReferences: [{ previewUrl: "https://example.com/p.jpg" }],
    })).toBe("https://example.com/p.jpg");
  });

  it("returns null when no media URLs are present", () => {
    expect(readCharacterThumbnailUrl({ displayName: "Hero" })).toBeNull();
  });
});

describe("readEntityList", () => {
  it("reads a list under the plural key", () => {
    const list = readEntityList(
      { voices: [{ voice: "v1", displayName: "Narrator" }, { voice: "v2", name: "Villain" }] },
      "voices",
      "voice",
    );
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ ref: "v1", display_name: "Narrator", thumbnail_url: null });
    expect(list[1]).toMatchObject({ ref: "v2", display_name: "Villain", thumbnail_url: null });
  });

  it("falls back to the first array-valued property", () => {
    const list = readEntityList({ data: [{ character: "c1" }] }, "characters", "character");
    expect(list).toHaveLength(1);
    expect(list[0].ref).toBe("c1");
  });

  it("reads character thumbnail when present on list item", () => {
    const list = readEntityList({
      characters: [{
        character: "c1",
        displayName: "Hero",
        thumbnailUrl: "https://example.com/t.jpg",
      }],
    }, "characters", "character");
    expect(list[0]).toMatchObject({
      ref: "c1",
      display_name: "Hero",
      thumbnail_url: "https://example.com/t.jpg",
    });
  });

  it("tolerates a bare-string list item", () => {
    const list = readEntityList({ voices: ["v1"] }, "voices", "voice");
    expect(list[0]).toMatchObject({ ref: "v1", display_name: null, thumbnail_url: null });
  });

  it("returns an empty list when nothing array-shaped is present", () => {
    expect(readEntityList({ status: "ok" }, "voices", "voice")).toEqual([]);
  });
});

describe("readGoogleFlowAccountEmails", () => {
  it("reads an accounts array of objects", () => {
    expect(readGoogleFlowAccountEmails({ accounts: [{ email: "a@b.com" }, { email: "c@d.com" }] }))
      .toEqual(["a@b.com", "c@d.com"]);
  });

  it("reads an email-keyed object map", () => {
    expect(readGoogleFlowAccountEmails({ "a@b.com": { plan: "pro" } })).toEqual(["a@b.com"]);
  });

  it("reads an accounts array of strings", () => {
    expect(readGoogleFlowAccountEmails({ accounts: ["a@b.com"] })).toEqual(["a@b.com"]);
  });

  it("dedupes repeated emails", () => {
    expect(readGoogleFlowAccountEmails({ "a@b.com": { email: "a@b.com" } })).toEqual(["a@b.com"]);
  });

  it("returns empty when no emails are present", () => {
    expect(readGoogleFlowAccountEmails({ status: "ok" })).toEqual([]);
  });
});

describe("resolveGoogleFlowEmail", () => {
  it("returns an explicit email without calling the provider", async () => {
    const calls: string[] = [];
    const provider = jsonProvider({ accounts: [] }, calls);
    expect(await resolveGoogleFlowEmail(provider, "explicit@x.com")).toBe("explicit@x.com");
    expect(calls).toHaveLength(0);
  });

  it("resolves the sole configured account", async () => {
    const provider = jsonProvider({ accounts: [{ email: "only@x.com" }] });
    expect(await resolveGoogleFlowEmail(provider)).toBe("only@x.com");
  });

  it("throws when no accounts are configured", async () => {
    const provider = jsonProvider({ accounts: [] });
    await expect(resolveGoogleFlowEmail(provider)).rejects.toThrow(/No Google Flow accounts/);
  });

  it("throws listing accounts when several are configured", async () => {
    const provider = jsonProvider({ accounts: [{ email: "a@x.com" }, { email: "b@x.com" }] });
    await expect(resolveGoogleFlowEmail(provider)).rejects.toThrow(/a@x.com, b@x.com/);
  });
});
