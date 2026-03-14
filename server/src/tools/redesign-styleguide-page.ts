import { z } from "zod";
import { openai } from "@nakedapi/openai";
import type { OpenAiContentPart } from "@nakedapi/openai";
import { takeScreenshot } from "../screenshot.js";
import type { ToolDef } from "./tool-def.js";

const VISION_SYSTEM_PROMPT = `You are an opinionated UI design consultant who makes interfaces more usable AND visually exciting — like a video game UI that's fun to look at and effortless to use.

Analyze this UI screenshot. Return the top 10 design changes that would make it more usable and look cool like a video game.

Focus on:
- Visual excitement: bold colors, dynamic contrast, glowing accents, satisfying micro-interactions
- Usability: clear hierarchy, intuitive flow, scannable information
- Information density: reclaim wasted space, make every pixel count
- Typography and readability: crisp, confident type choices
- Spacing, alignment, and density
- Subtle game-inspired flourishes: progress indicators, status badges, animated transitions, HUD-style elements

Be specific and blunt. Name exact elements, colors, sizes, and positions.

Return JSON:
{
  "changes": [
    "specific change 1",
    "specific change 2",
    ...
  ]
}

Return exactly 10 changes. Each should be a concrete, actionable design change — not vague advice.`;

export function redesignStyleguidePageDef(): ToolDef {
  return {
    name: "redesign_styleguide_page",
    description:
      "Screenshot a styleguide page and get 10 specific design improvements via GPT-5.4 vision that make it more usable and visually exciting.",
    schema: {
      page: z.number().int().min(1).max(11).describe("Styleguide page number (1-11)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { page, project_slug } = args as {
        page: number;
        project_slug: string;
      };

      void project_slug;

      if (!process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      // Check dev server is reachable
      const devUrl = `http://localhost:5173/styleguide/${page}`;
      try {
        const check = await fetch(devUrl);
        if (!check.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Dev server returned ${check.status} for ${devUrl}. Is npm run dev:client running?` }],
          };
        }
      } catch {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Cannot reach dev server at ${devUrl}. Start it with: npm run dev:client` }],
        };
      }

      // 1. Screenshot
      const screenshotBuffer = await takeScreenshot({ url: devUrl, width: 1920, height: 1080 });

      // 2. Vision analysis via GPT-5.4
      const base64 = screenshotBuffer.toString("base64");
      const dataUri = `data:image/png;base64,${base64}`;

      const userContent: OpenAiContentPart[] = [
        { type: "text", text: "Analyze this UI screenshot and return your top 10 design changes as JSON." },
        { type: "image_url", image_url: { url: dataUri, detail: "high" } },
      ];

      const provider = openai({ apiKey: process.env.OPENAI_API_KEY, timeout: 180_000 });
      const chatResult = await provider.v1.chat.completions({
        model: "gpt-5.4",
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: 0.4,
        max_completion_tokens: 4096,
      });

      const analysis = JSON.parse(chatResult.content) as { changes: string[] };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(analysis),
        }],
      };
    },
  };
}
