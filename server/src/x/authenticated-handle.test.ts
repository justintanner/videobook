import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchAuthenticatedXHandle } from "./authenticated-handle.js";
import { getValidAccessToken } from "./x-tokens.js";

vi.mock("./x-tokens.js", () => ({
  getValidAccessToken: vi.fn(),
}));

describe("fetchAuthenticatedXHandle", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.mocked(getValidAccessToken).mockResolvedValue("test-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("returns normalized handle on successful /2/users/me response", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/2/users/me")) {
        return new Response(
          JSON.stringify({
            data: {
              id: "12345",
              name: "Live User",
              username: "  @LiveUser  ",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const handle = await fetchAuthenticatedXHandle();
    expect(handle).toBe("LiveUser");
  });

  it("returns null if getValidAccessToken throws", async () => {
    vi.mocked(getValidAccessToken).mockRejectedValue(new Error("No token"));
    const handle = await fetchAuthenticatedXHandle();
    expect(handle).toBeNull();
  });

  it("returns null on network/API failure", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response("Bad Request", { status: 400 });
    });

    const handle = await fetchAuthenticatedXHandle();
    expect(handle).toBeNull();
  });

  it("returns null if response is missing username", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          data: {
            id: "12345",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const handle = await fetchAuthenticatedXHandle();
    expect(handle).toBeNull();
  });
});
