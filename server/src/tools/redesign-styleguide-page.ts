import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { openai } from "@nakedapi/openai";
import type { OpenAiContentPart } from "@nakedapi/openai";
import { queue } from "../queue.js";
import { takeScreenshot } from "../screenshot.js";
import type { ToolDef } from "./tool-def.js";

const VISION_SYSTEM_PROMPT = `You are an opinionated UI design consultant influenced by Edward Tufte's principles: data-ink ratio, clarity, visual hierarchy, and information density. You have high standards and don't pull punches.

Analyze this UI screenshot. Identify the 3-5 most impactful improvements that would make this interface clearer, more usable, and more information-dense. Preserve the fundamental layout and visual identity, but don't be shy about making bold changes within that structure.

Focus on:
- Wasted space that should be reclaimed for useful information
- Low-contrast or hard-to-read elements that need real fixes, not tweaks
- Visual clutter and decorative weight that should be stripped away
- Hierarchy problems — be direct about what's fighting for attention and shouldn't be
- Spacing, alignment, and density — every pixel should justify its existence

Be specific and blunt. "The sidebar labels are nearly invisible at this contrast" not "consider adjusting contrast." Name exact elements, colors, and sizes.

Return JSON:
{
  "critique": ["specific issue 1", "specific issue 2", ...],
  "prompt": "A detailed image generation prompt describing the improved UI mockup..."
}

The prompt must describe the SAME UI with the improvements applied — same layout structure, same color palette, same visual identity. But push the changes hard: tighter spacing, bolder hierarchy, less wasted space, stronger contrast where it matters. Describe specific changes to elements: what moved, resized, recolored, was added, or was removed. Be precise about positions, sizes, colors, and typography. The result should look like the same interface after a focused, confident design pass — not a timid nudge.`;

function buildSystemPrompt(focus?: string): string {
  if (!focus) return VISION_SYSTEM_PROMPT;
  return VISION_SYSTEM_PROMPT + `\n\nPay special attention to this area: ${focus}`;
}

export function redesignStyleguidePageDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "redesign_styleguide_page",
    description:
      "Screenshot a styleguide page, identify 3-5 specific improvements via GPT-5.4 vision, and generate an improved mockup via nano-banana-pro that preserves the existing design.",
    schema: {
      page: z.number().int().min(1).max(11).describe("Styleguide page number (1-11)"),
      project_slug: z.string().describe("Project slug"),
      focus: z.string().optional().describe("Optional area to focus the design critique on"),
      aspect_ratio: z
        .enum(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"])
        .optional()
        .describe("Aspect ratio for generated mockup"),
      resolution: z.enum(["1K", "2K", "4K"]).optional().describe("Output resolution"),
    },
    handler: async (args) => {
      const {
        page,
        project_slug,
        focus,
        aspect_ratio,
        resolution,
      } = args as {
        page: number;
        project_slug: string;
        focus?: string;
        aspect_ratio?: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9" | "auto";
        resolution?: "1K" | "2K" | "4K";
      };

      if (!process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }
      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
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

      // 2. Save screenshot asset
      const screenshotAssetResult = await fs.createAsset("img", `styleguide-p${page}-screenshot`, project_slug);
      if (!screenshotAssetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create screenshot asset: ${screenshotAssetResult.error.message}` }],
        };
      }
      const { assetId: screenshotAssetId } = screenshotAssetResult.value;
      await fs.writeFile(screenshotAssetId, "screenshot.png", screenshotBuffer, project_slug);

      // 3. Vision analysis via GPT-5.4
      const base64 = screenshotBuffer.toString("base64");
      const dataUri = `data:image/png;base64,${base64}`;

      const userContent: OpenAiContentPart[] = [
        { type: "text", text: "Analyze this UI screenshot and return your critique + generation prompt as JSON." },
        { type: "image_url", image_url: { url: dataUri, detail: "high" } },
      ];

      const provider = openai({ apiKey: process.env.OPENAI_API_KEY, timeout: 180_000 });
      const chatResult = await provider.v1.chat.completions({
        model: "gpt-5.4",
        messages: [
          { role: "system", content: buildSystemPrompt(focus) },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: 0.4,
        max_completion_tokens: 4096,
      });

      const analysis = JSON.parse(chatResult.content) as { critique: string[]; prompt: string };

      // 4. Save analysis metadata
      await fs.writeMetadata(screenshotAssetId, "design-analysis", analysis, project_slug);

      // 5. Create output asset for redesign
      const redesignAssetResult = await fs.createAsset("img", `styleguide-p${page}-redesign`, project_slug);
      if (!redesignAssetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create redesign asset: ${redesignAssetResult.error.message}` }],
        };
      }
      const { assetId: redesignAssetId, path: redesignAssetDir } = redesignAssetResult.value;

      // 6. Enqueue generation job
      const jobId = `redesign-styleguide-p${page}-${redesignAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "redesign_styleguide_page",
        prompt: analysis.prompt,
        screenshotAssetId,
        screenshotFilename: "screenshot.png",
        redesignAssetId,
        redesignAssetDir,
        projectSlug: project_slug,
        aspectRatio: aspect_ratio ?? "16:9",
        resolution: resolution ?? "2K",
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            screenshot_asset_id: screenshotAssetId,
            redesign_asset_id: redesignAssetId,
            job_id: jobId,
            critique: analysis.critique,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
