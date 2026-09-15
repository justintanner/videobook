import { describe, it, expect } from "vitest";
import {
  settingIsRequested,
  withoutUnrequestedSettings,
} from "./chat-generation-settings.js";

// The routed turn that started this: a spoken request with no settings in it,
// answered with a duration and a muted soundtrack the speaker never asked for.
const SPOKEN_QUERY =
  "Make a seedance video with the kittens in @a1 dancing like the video in @a2";

const ROUTED_PARAMS = {
  prompt: "Kittens from @a1 dancing like @a2",
  image_refs: ["@a1"],
  video_refs: ["@a2"],
  duration: "22",
  generate_audio: false,
};

describe("withoutUnrequestedSettings", () => {
  it("drops the settings the spoken request never asked for", () => {
    const { params, dropped } = withoutUnrequestedSettings({
      query: SPOKEN_QUERY,
      params: ROUTED_PARAMS,
      requiredParams: [],
    });
    expect(dropped).toEqual(["duration", "generate_audio"]);
    expect(params).toEqual({
      prompt: "Kittens from @a1 dancing like @a2",
      image_refs: ["@a1"],
      video_refs: ["@a2"],
    });
  });

  it("keeps the prompt and every reference parameter", () => {
    const { dropped } = withoutUnrequestedSettings({
      query: SPOKEN_QUERY,
      params: ROUTED_PARAMS,
      requiredParams: [],
    });
    expect(dropped).not.toContain("prompt");
    expect(dropped).not.toContain("image_refs");
    expect(dropped).not.toContain("video_refs");
  });

  it("keeps a setting the tool schema marks required", () => {
    const { params, dropped } = withoutUnrequestedSettings({
      query: SPOKEN_QUERY,
      params: { duration: "22", aspect_ratio: "16:9" },
      requiredParams: ["duration", "aspect_ratio"],
    });
    expect(dropped).toEqual([]);
    expect(params).toEqual({ duration: "22", aspect_ratio: "16:9" });
  });

  it("keeps a setting with no evidence rule of its own", () => {
    const { params, dropped } = withoutUnrequestedSettings({
      query: SPOKEN_QUERY,
      params: { mode: "spicy", negative_prompt: "blurry" },
      requiredParams: [],
    });
    expect(dropped).toEqual([]);
    expect(params).toEqual({ mode: "spicy", negative_prompt: "blurry" });
  });

  it("leaves params untouched when the request asks for everything it got", () => {
    const params = {
      prompt: "kittens dancing",
      duration: "12",
      resolution: "1080p",
      generate_audio: true,
    };
    const result = withoutUnrequestedSettings({
      query: "make a 12 second 1080p video of kittens dancing with music",
      params,
      requiredParams: [],
    });
    expect(result.dropped).toEqual([]);
    expect(result.params).toEqual(params);
  });
});

describe("settingIsRequested", () => {
  it("reads a duration from a number with a time unit or from length words", () => {
    expect(settingIsRequested("duration", "a 12 second clip")).toBe(true);
    expect(settingIsRequested("duration", "make it 2 minutes")).toBe(true);
    expect(settingIsRequested("duration", "make it shorter")).toBe(true);
    expect(settingIsRequested("duration", "kittens dancing on a freeway")).toBe(false);
  });

  it("does not read a bare number as a duration", () => {
    expect(settingIsRequested("duration", "3 kittens dancing")).toBe(false);
  });

  it("reads the audio toggle from any of the words people use for it", () => {
    for (const query of [
      "with music",
      "make it silent",
      "no sound",
      "add narration",
      "keep the dialogue",
    ]) {
      expect(settingIsRequested("generate_audio", query)).toBe(true);
    }
    expect(settingIsRequested("generate_audio", "kittens dancing")).toBe(false);
  });

  it("spells the audio toggle four ways and answers the same for each", () => {
    for (const name of ["generate_audio", "audio", "sound", "audio_setting"]) {
      expect(settingIsRequested(name, "with a soundtrack")).toBe(true);
      expect(settingIsRequested(name, "kittens dancing")).toBe(false);
    }
  });

  it("reads a resolution from its own vocabulary, not from any number", () => {
    expect(settingIsRequested("resolution", "in 1080p")).toBe(true);
    expect(settingIsRequested("resolution", "make it 4k")).toBe(true);
    expect(settingIsRequested("resolution", "720 kittens")).toBe(false);
  });

  it("reads an aspect ratio from a real ratio or an orientation word", () => {
    expect(settingIsRequested("aspect_ratio", "make it 9:16")).toBe(true);
    expect(settingIsRequested("aspect_ratio", "vertical please")).toBe(true);
    expect(settingIsRequested("aspect_ratio", "kittens dancing")).toBe(false);
  });

  it("does not read a timestamp as an aspect ratio", () => {
    expect(settingIsRequested("aspect_ratio", "start at 1:30")).toBe(false);
  });

  it("treats an unknown setting as always requested", () => {
    expect(settingIsRequested("customize_multi_shots", "kittens dancing")).toBe(true);
  });
});
