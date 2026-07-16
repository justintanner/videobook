import { describe, expect, it } from "vitest";
import { withRemotionCancellation } from "./remotion-cancellation.js";

describe("withRemotionCancellation", () => {
  it("forwards an abort to the active Remotion render", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const rendering = withRemotionCancellation(
      controller.signal,
      async (cancelSignal) => new Promise<never>((_resolve, reject) => {
        cancelSignal(() => {
          cancelled = true;
          reject(new Error("Remotion render cancelled"));
        });
      }),
    );

    controller.abort(new Error("render deadline expired"));

    await expect(rendering).rejects.toThrow("Remotion render cancelled");
    expect(cancelled).toBe(true);
  });

  it("does not start a render after the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("render deadline expired"));
    let started = false;

    await expect(withRemotionCancellation(controller.signal, async () => {
      started = true;
    })).rejects.toThrow("render deadline expired");
    expect(started).toBe(false);
  });
});
