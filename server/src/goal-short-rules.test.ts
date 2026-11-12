import { describe, expect, it } from "vitest";
import {
  SHORT_AVOID, SHORT_BANNED_WORDS, SHORT_RULES, shortBannedWords, shortMentionsPhone, shortRulesOutPhone, shortWantsPhone, stripShortBannedWords,
  withoutShortPhoneSentences,
} from "./goal-short-rules.js";

describe("short rule lines", () => {
  it("keeps the frame, video and silence lines of the plan word for word", () => {
    expect(SHORT_RULES).toEqual({
      frame: "Candid phone photo taken in available light in an ordinary real place. Natural colour, unretouched skin, slightly imperfect framing. No text, captions, logos, borders or watermarks.",
      video: "Real phone footage filmed by someone off screen, in one continuous take at real-time speed, with slight handheld camera movement and natural weight and physics. No slow motion, cuts, zooms, effects or on-screen text.",
      silence: "The main character never speaks: no dialogue, voiceover, narration or singing, lips closed. No music. Natural ambient sound only.",
    });
  });

  it("puts the phone of the video line with whoever films off screen, never in the main character's hand", () => {
    expect(SHORT_RULES.video.match(/[^.]*phone[^.]*/giu)).toEqual(["Real phone footage filmed by someone off screen, in one continuous take at real-time speed, with slight handheld camera movement and natural weight and physics"]);
    expect(`${SHORT_RULES.video} ${SHORT_RULES.silence}`).not.toMatch(/\b(?:holds?|holding|carr(?:y|ies|ying)|hand)\b/iu);
  });

  it("names the main character and the same person rather than a pronoun, so a new description still reads", () => {
    for (const line of Object.values(SHORT_RULES)) expect(line).not.toMatch(/\b(?:he|him|his|she|her)\b/iu);
  });

  it("uses none of the banned words itself", () => {
    expect(shortBannedWords(Object.values(SHORT_RULES).join("\n"))).toEqual([]);
  });

  it("lists the banned words and the avoid list of the plan", () => {
    expect(SHORT_BANNED_WORDS).toEqual([
      "cinematic", "masterpiece", "editorial", "epic", "stunning", "hyperrealistic", "hyper-realistic", "photorealistic",
      "ultra-detailed", "8k", "4k", "bokeh", "anamorphic", "Portra", "Cinestill", "Kodak", "film still", "studio lighting",
      "dramatic lighting", "octane", "unreal engine",
    ]);
    expect(SHORT_AVOID).toEqual([
      "close-ups of hands or fingers",
      "readable signs, screens or labels",
      "crowds of faces",
      "mirrors and reflections",
      "fast or acrobatic movement",
      "anything that needs speech",
    ]);
  });
});

describe("shortBannedWords", () => {
  it("finds whole banned words and phrases without regard to case, each once in list order", () => {
    expect(shortBannedWords("An EPIC, Cinematic shot on kodak portra. Epic again, in 8K with Studio\nLighting and Unreal  Engine."))
      .toEqual(["cinematic", "epic", "8k", "Portra", "Kodak", "studio lighting", "unreal engine"]);
    expect(shortBannedWords("Hyper-realistic, ultra-detailed bokeh")).toEqual(["hyper-realistic", "ultra-detailed", "bokeh"]);
  });

  it("ignores banned words inside other words", () => {
    expect(shortBannedWords("The epicenter of a 48k crowd, cinematically lit by octanes of hyperrealisticness")).toEqual([]);
  });

  it("finds nothing in plain phone-footage prose", () => {
    expect(shortBannedWords("He waits at the bus stop in the rain, checks the road, then steps back from a splash.")).toEqual([]);
  });
});

describe("stripShortBannedWords", () => {
  it("removes banned words and tidies the spacing and punctuation they leave", () => {
    expect(stripShortBannedWords("A cinematic shot of him waiting, 8k, bokeh.")).toBe("A shot of him waiting.");
    expect(stripShortBannedWords("A stunning, epic view of the  street at dusk")).toBe("A view of the street at dusk");
    expect(stripShortBannedWords("Cinematic, he crosses the road. Studio lighting.")).toBe("he crosses the road.");
    expect(stripShortBannedWords("He walks home , photorealistic\nThen he stops, Kodak Portra.")).toBe("He walks home\nThen he stops.");
  });

  it("leaves text without a banned word exactly as it was", () => {
    const text = "He waits ,  under the shelter.\n\nThe bus comes .";
    expect(stripShortBannedWords(text)).toBe(text);
  });

  it("leaves no banned word behind", () => {
    const everything = SHORT_BANNED_WORDS.map((word) => `${word.toUpperCase()} light`).join(", ");
    const stripped = stripShortBannedWords(everything);
    expect(shortBannedWords(stripped)).toEqual([]);
    expect(stripped).toBe(Array.from(SHORT_BANNED_WORDS, () => "light").join(", "));
  });
});

describe("phones in short prompts", () => {
  it("finds a phone by any of its names, and nothing inside other words", () => {
    for (const text of ["The phone stays at chest height.", "He checks his smartphone", "an iPhone", "PHONES on the bench", "a payphone", "his cell phone", "a cellphone"]) {
      expect(shortMentionsPhone(text), text).toBe(true);
    }
    for (const text of ["He wears headphones", "a phonetic sign", "a telephoto look", "He waits for the bus"]) expect(shortMentionsPhone(text), text).toBe(false);
  });

  it("reads feedback that rules a phone out, clause by clause", () => {
    for (const text of ["He does not hold a phone.", "He doesn't hold a phone", "He doesn’t carry his phone", "No phone.", "He waits without his phone", "Never a phone in his hand"]) {
      expect(shortRulesOutPhone(text), text).toBe(true);
    }
    for (const text of ["He checks his phone.", "No, he holds a phone.", "The bus shows no writing. He holds his phone.", "He does not look up"]) {
      expect(shortRulesOutPhone(text), text).toBe(false);
    }
  });

  it("wants a phone only when one is asked for and not ruled out", () => {
    expect(shortWantsPhone("he checks his phone at the bus stop")).toBe(true);
    expect(shortWantsPhone("A bus splashes him. He does not hold a phone.")).toBe(false);
    expect(shortWantsPhone("he waits for a bus in the rain")).toBe(false);
  });

  it("drops each sentence that names a phone and keeps the rest word for word", () => {
    expect(withoutShortPhoneSentences("He waits under the shelter. The phone stays at chest height, keeping him framed. Rain patters on the roof."))
      .toBe("He waits under the shelter. Rain patters on the roof.");
    expect(withoutShortPhoneSentences("He checks the road!  A bus passes? The iPhone shakes.")).toBe("He checks the road! A bus passes?");
    expect(withoutShortPhoneSentences("The phone stays at chest height.")).toBe("");
  });
});
