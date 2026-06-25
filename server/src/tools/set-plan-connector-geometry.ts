import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

// A char_swap plan's flow connectors (the vertical joins between stacked nodes)
// can be bent on the canvas via a draggable midpoint handle. The bend is a
// normalized offset `{ dx, dy }` in [-1, 1] (fraction of the connector box's
// half-width / half-height); { dx: 0, dy: 0 } is a straight line. Geometry is
// keyed by a stable connector id ("s0-source-swap", "s0-swap-video", "s1-gap",
// …) under sidecar.connectors. Writing { 0, 0 } resets (removes) the key so we
// never persist no-op defaults.
type ConnectorGeometry = { dx: number; dy: number };

type PlanSidecar = {
  scenes: Array<{ start: number; end: number; visual: string }>;
  source_asset_id: string;
  characters: Array<{ asset_id: string; name: string; description: string }>;
  total_duration_s: number;
  max_scene_seconds: number;
  model: string;
  connectors?: Record<string, ConnectorGeometry>;
};

const schema = {
  project_slug: z.string().describe("Project slug"),
  connector_id: z
    .string()
    .min(1)
    .describe('Stable connector id, e.g. "s0-source-swap", "s0-swap-video", "s1-gap"'),
  dx: z.number().describe("Normalized horizontal bend in [-1, 1] (fraction of the connector's half-width)"),
  dy: z.number().describe("Normalized vertical bend in [-1, 1] (fraction of the connector's half-height)"),
};

export function setPlanConnectorGeometryDef(fs: VideocityFs): ToolDef {
  return {
    name: "set_plan_connector_geometry",
    description:
      "Persist the bend geometry of a char_swap plan flow connector. Writes sidecar.connectors[connector_id] = { dx, dy } (normalized [-1, 1] handle offset). dx === 0 && dy === 0 resets the connector to straight (removes the key, and the connectors object when it becomes empty). Returns the updated sidecar.",
    schema,
    handler: async (args) => {
      const { project_slug, connector_id, dx, dy } = args as {
        project_slug: string;
        connector_id: string;
        dx: number;
        dy: number;
      };

      const planRead = await fs.readFile("plan", ".plan.json", project_slug);
      if (!planRead.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No plan in ${project_slug}: ${planRead.error.message}` }],
        };
      }
      let plan: PlanSidecar;
      try {
        plan = JSON.parse(Buffer.from(planRead.value).toString("utf-8")) as PlanSidecar;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid .plan.json: ${msg}` }],
        };
      }

      const reset = dx === 0 && dy === 0;
      if (reset) {
        if (plan.connectors) {
          delete plan.connectors[connector_id];
          if (Object.keys(plan.connectors).length === 0) delete plan.connectors;
        }
      } else {
        plan.connectors = { ...plan.connectors, [connector_id]: { dx, dy } };
      }

      const writeResult = await fs.writeFile(
        "plan",
        ".plan.json",
        JSON.stringify(plan, null, 2),
        project_slug,
      );
      if (!writeResult.ok) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Failed to update .plan.json: ${writeResult.error.message}`,
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ connector_id, dx, dy, sidecar: plan }),
        }],
      };
    },
  };
}
