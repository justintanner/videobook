import type { ClipfirstFs } from "clipfirst-fs";
import type { ToolDef } from "./tool-def.js";

interface SkillParam {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
}

interface Skill {
  command: string;
  description: string;
  category: "action" | "project" | "context_menu";
  icon: string;
  size: "sm" | "default" | "lg";
  variant: "default" | "violet";
  chevron: "right" | "down";
  params: SkillParam[];
}

const HARDCODED_SKILLS: Skill[] = [
  {
    command: "/generate",
    description: "Generate content from prompt",
    category: "action",
    icon: "Zap",
    size: "lg",
    variant: "default",
    chevron: "right",
    params: [
      { name: "prompt", type: "string", required: true, description: "The prompt to generate from" },
      { name: "model", type: "string", required: false, description: "Model to use for generation" },
    ],
  },
  {
    command: "/rewrite-prompt",
    description: "Optimize a prompt",
    category: "action",
    icon: "Sparkles",
    size: "sm",
    variant: "default",
    chevron: "right",
    params: [
      { name: "prompt", type: "string", required: true, description: "The prompt to rewrite" },
    ],
  },
  {
    command: "/trim",
    description: "Trim video clip",
    category: "action",
    icon: "Scissors",
    size: "lg",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to trim" },
      { name: "start", type: "string", required: false, description: "Start timestamp" },
      { name: "end", type: "string", required: false, description: "End timestamp" },
    ],
  },
  {
    command: "/trim-audio",
    description: "Trim audio clip",
    category: "action",
    icon: "Scissors",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to trim" },
      { name: "start", type: "string", required: false, description: "Start timestamp" },
      { name: "end", type: "string", required: false, description: "End timestamp" },
    ],
  },
  {
    command: "/isolate-vocals",
    description: "Isolate vocals from audio",
    category: "action",
    icon: "Mic",
    size: "default",
    variant: "violet",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to isolate vocals from" },
    ],
  },
  {
    command: "/apply",
    description: "Apply current action",
    category: "action",
    icon: "Check",
    size: "lg",
    variant: "default",
    chevron: "right",
    params: [],
  },
  {
    command: "/final",
    description: "Finalize and export",
    category: "action",
    icon: "Clapperboard",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [],
  },
  {
    command: "/inbox",
    description: "View generations inbox",
    category: "action",
    icon: "Mailbox",
    size: "default",
    variant: "default",
    chevron: "down",
    params: [],
  },
  {
    command: "/copy-name",
    description: "Copy asset name",
    category: "context_menu",
    icon: "ClipboardCopy",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset whose name to copy" },
    ],
  },
  {
    command: "/open-folder",
    description: "Open asset folder",
    category: "context_menu",
    icon: "FolderOpen",
    size: "default",
    variant: "default",
    chevron: "right",
    params: [
      { name: "asset_id", type: "string", required: true, description: "Asset to open folder for" },
      { name: "project_slug", type: "string", required: true, description: "Project containing the asset" },
    ],
  },
];

export function skillsDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "skills",
    description: "List all available slash commands (hardcoded actions and dynamic project skills)",
    schema: {},
    handler: async () => {
      const projects = await fs.listProjects({ sort: "newest" });
      const projectSkills: Skill[] = projects.map((p) => ({
        command: `/${p.slug}`,
        description: `Switch to project ${p.slug}`,
        category: "project" as const,
        icon: "FolderOpen",
        size: "default" as const,
        variant: "default" as const,
        chevron: "down" as const,
        params: [],
      }));
      const allSkills = [...HARDCODED_SKILLS, ...projectSkills];
      return {
        content: [{ type: "text" as const, text: JSON.stringify(allSkills) }],
      };
    },
  };
}
