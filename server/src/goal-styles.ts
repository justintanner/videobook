export const GOAL_STYLE_IDS = ["cinematic", "ig-influencer"] as const;
export type GoalStyleId = typeof GOAL_STYLE_IDS[number];
export type GoalStyleSelection = { id: GoalStyleId; options: Record<string, string> };
export type GoalStyleStage = "frame" | "storyboard" | "ending" | "video" | "revise";
export type GoalStyleOption = {
  key: string;
  label: string;
  default: string;
  choices: { value: string; label: string; prompt: string; briefKeywords: string[]; beats?: string }[];
};
export type GoalStyle = {
  id: GoalStyleId;
  label: string;
  summary: string;
  briefKeywords: string[];
  defaults: { aspectRatio?: "16:9" | "9:16" | "1:1"; imageModel?: "sunburst" | "flare"; imageResolution?: "1K" | "2K"; videoResolution?: "480p" | "720p" };
  planner: string;
  fragments: Record<GoalStyleStage, string>;
  banned: string[];
  options: GoalStyleOption[];
};

const styles: Record<GoalStyleId, GoalStyle> = {
  cinematic: {
    id: "cinematic", label: "Cinematic", summary: "A coherent sequence with a shared visual style.",
    briefKeywords: ["cinematic"], defaults: {}, planner: "",
    fragments: { frame: "", storyboard: "", ending: "", video: "", revise: "" },
    banned: [], options: [],
  },
  "ig-influencer": {
    id: "ig-influencer", label: "IG Influencer", summary: "Hyper-realistic, candid iPhone footage with natural skin and light.",
    briefKeywords: ["ig influencer", "instagram influencer", "influencer", "insta reel", "instagram reel"],
    defaults: { aspectRatio: "9:16", imageModel: "sunburst", imageResolution: "2K", videoResolution: "720p" },
    planner: "Use a hyper-realistic Instagram phone-camera register: real-world activity in present tense, one location per shot, candid framing with slight imperfection, light grain, unretouched skin with visible pores and texture. Use the selected iPhone camera and lighting; natural daylight or soft indoor light by default. No HDR crunch, beautify, captions or on-screen text. Avoid cinematic, masterpiece, editorial, Portra, Cinestill and all film-stock vocabulary. Match the delivery: address the camera for selfies, be caught mid-action when filmed by a friend, hold framing steady on a tripod, or show the reflection for a mirror shot. Make the selected content format explicit in the four beats. Sound is ambient room or street sound with an optional short spoken line.",
    fragments: {
      frame: "hyper-realistic candid photo, unretouched skin, visible pores, light grain",
      storyboard: "hyper-realistic candid photo, unretouched skin, visible pores, light grain",
      ending: "hyper-realistic candid photo, unretouched skin, visible pores",
      video: "hyper-realistic unretouched pores, natural motion, handheld micro-shake, ambient sound, optional short speech",
      revise: "hyper-realistic candid photo, unretouched skin, visible pores",
    },
    banned: ["cinematic", "masterpiece", "editorial", "Portra", "Cinestill"],
    options: [
      {
        key: "format", label: "Content format", default: "day-in-the-life",
        choices: [
          { value: "grwm", label: "GRWM", prompt: "GRWM", briefKeywords: ["grwm", "get ready with me"], beats: "skincare, outfit, final look, mirror check" },
          { value: "ootd", label: "OOTD", prompt: "OOTD", briefKeywords: ["ootd", "outfit of the day"], beats: "reveal, details, walk, turn" },
          { value: "day-in-the-life", label: "Day in the life", prompt: "day-in-the-life", briefKeywords: ["day in the life", "vlog"], beats: "arrive, begin activity, react, finish" },
          { value: "travel-reel", label: "Travel reel", prompt: "travel", briefKeywords: ["travel reel"], beats: "arrive, explore, discover, farewell" },
          { value: "cafe", label: "Café", prompt: "café", briefKeywords: ["brunch", "cafe", "café"], beats: "order, receive drink, taste, smile" },
          { value: "gym", label: "Gym", prompt: "gym", briefKeywords: ["gym"], beats: "warm up, exercise, effort, recover" },
          { value: "skincare", label: "Skincare", prompt: "skincare", briefKeywords: ["skincare"], beats: "cleanse, apply, massage, reveal" },
          { value: "haul", label: "Haul", prompt: "haul", briefKeywords: ["haul"], beats: "unpack, show item, try on, react" },
          { value: "storytime", label: "Storytime", prompt: "storytime", briefKeywords: ["storytime"], beats: "hook, explain, react, conclude" },
        ],
      },
      {
        key: "delivery", label: "Delivery", default: "selfie-to-camera",
        choices: [
          { value: "selfie-to-camera", label: "Selfie to camera", prompt: "selfie", briefKeywords: ["selfie", "front camera"] },
          { value: "filmed-by-friend", label: "Filmed by a friend", prompt: "friend-filmed", briefKeywords: ["filmed by"] },
          { value: "tripod", label: "Tripod", prompt: "tripod", briefKeywords: ["tripod"] },
          { value: "mirror", label: "Mirror", prompt: "mirror", briefKeywords: ["mirror"] },
        ],
      },
      {
        key: "camera", label: "Camera", default: "iphone-front",
        choices: [
          { value: "iphone-front", label: "iPhone front camera", prompt: "iPhone front", briefKeywords: ["front camera", "iphone front"] },
          { value: "iphone-main", label: "iPhone main camera", prompt: "iPhone main", briefKeywords: ["main camera", "iphone main"] },
        ],
      },
      {
        key: "light", label: "Light", default: "soft-daylight",
        choices: [
          { value: "soft-daylight", label: "Soft daylight", prompt: "soft daylight", briefKeywords: ["soft daylight", "natural daylight"] },
          { value: "golden-hour", label: "Golden hour", prompt: "golden hour", briefKeywords: ["golden hour"] },
          { value: "indoor-warm", label: "Warm indoor light", prompt: "warm indoor", briefKeywords: ["warm indoor", "indoor warm"] },
          { value: "night-flash", label: "Night flash", prompt: "night flash", briefKeywords: ["night out", "flash"] },
        ],
      },
    ],
  },
};

export function goalStyle(id: GoalStyleId): GoalStyle {
  return styles[id];
}

export function resolveGoalStyleOptions(id: GoalStyleId, partial: Record<string, string> = {}): Record<string, string> {
  const style = goalStyle(id);
  for (const key of Object.keys(partial)) {
    if (!style.options.some(option => option.key === key)) throw new Error(`Unknown ${style.label} option: ${key}`);
  }
  const resolved: Record<string, string> = {};
  for (const option of style.options) {
    const fallback = option.key === "camera" && resolved.delivery !== "selfie-to-camera" ? "iphone-main" : option.default;
    const value = partial[option.key] ?? fallback;
    if (!option.choices.some(choice => choice.value === value)) {
      throw new Error(`Invalid ${style.label} ${option.label}: ${value}. Choose ${option.choices.map(choice => choice.value).join(", ")}.`);
    }
    resolved[option.key] = value;
  }
  return resolved;
}

export function goalStyleFragment(selection: GoalStyleSelection, stage: GoalStyleStage): string {
  const style = goalStyle(selection.id);
  const options = resolveGoalStyleOptions(selection.id, selection.options);
  let fragment = style.fragments[stage];
  if (!fragment) return "";
  if (stage === "video" && options.delivery === "tripod") fragment = fragment.replace("handheld micro-shake", "steady framing");
  const pieces = style.options.map(option => option.choices.find(choice => choice.value === options[option.key])!.prompt);
  return `${pieces.join(", ")}: ${fragment}.`;
}

export function goalStyleSummary(selection: GoalStyleSelection): string {
  const style = goalStyle(selection.id);
  const options = resolveGoalStyleOptions(selection.id, selection.options);
  return [style.label, ...style.options.map(option => option.choices.find(choice => choice.value === options[option.key])!.label)].join(" · ");
}
