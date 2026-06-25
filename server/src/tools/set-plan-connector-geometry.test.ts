import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFs } from "videocity-engine";
import type { VideocityFs } from "videocity-engine";
import { setPlanConnectorGeometryDef } from "./set-plan-connector-geometry.js";

type TextContent = Array<{ type: string; text: string }>;
type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } };

const PROJECT = "test-proj";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("set_plan_connector_geometry", () => {
  let tempDir: string;
  let fs: VideocityFs;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-connector-geom-test-"));
    fs = createFs({ projectsDir: tempDir });
    unwrap(await fs.createProject(PROJECT));

    const project = unwrap(await fs.getProject(PROJECT));
    await mkdir(join(project.path, "plan"), { recursive: true });
    const sidecar = {
      scenes: [{ start: 0, end: 8, visual: "scene" }],
      source_asset_id: "vid-source",
      characters: [{ asset_id: "char-a", name: "C1", description: "" }],
      total_duration_s: 8,
      max_scene_seconds: 14,
      model: "test",
    };
    unwrap(await fs.writeFile("plan", ".plan.json", JSON.stringify(sidecar, null, 2), PROJECT));
  });

  afterEach(async () => {
    fs.close();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function readConnectors(): Promise<Record<string, { dx: number; dy: number }> | undefined> {
    const parsed = JSON.parse(
      Buffer.from(unwrap(await fs.readFile("plan", ".plan.json", PROJECT)) as Uint8Array).toString("utf-8"),
    ) as { connectors?: Record<string, { dx: number; dy: number }> };
    return parsed.connectors;
  }

  it("writes connector geometry under sidecar.connectors", async () => {
    const result = await setPlanConnectorGeometryDef(fs).handler({
      project_slug: PROJECT,
      connector_id: "s0-source-swap",
      dx: 0.4,
      dy: -0.2,
    });
    expect(result.isError).toBeFalsy();
    expect(await readConnectors()).toEqual({ "s0-source-swap": { dx: 0.4, dy: -0.2 } });
  });

  it("returns the updated sidecar in the response payload", async () => {
    const result = await setPlanConnectorGeometryDef(fs).handler({
      project_slug: PROJECT,
      connector_id: "s0-swap-video",
      dx: 0.5,
      dy: 0,
    });
    const parsed = JSON.parse((result.content as TextContent)[0].text) as {
      sidecar: { connectors?: Record<string, { dx: number; dy: number }> };
    };
    expect(parsed.sidecar.connectors).toEqual({ "s0-swap-video": { dx: 0.5, dy: 0 } });
  });

  it("keeps multiple connectors independent", async () => {
    await setPlanConnectorGeometryDef(fs).handler({ project_slug: PROJECT, connector_id: "s0-source-swap", dx: 0.3, dy: 0 });
    await setPlanConnectorGeometryDef(fs).handler({ project_slug: PROJECT, connector_id: "s0-swap-video", dx: -0.6, dy: 0.1 });
    expect(await readConnectors()).toEqual({
      "s0-source-swap": { dx: 0.3, dy: 0 },
      "s0-swap-video": { dx: -0.6, dy: 0.1 },
    });
  });

  it("overwrites an existing connector's geometry", async () => {
    await setPlanConnectorGeometryDef(fs).handler({ project_slug: PROJECT, connector_id: "s0-source-swap", dx: 0.3, dy: 0 });
    await setPlanConnectorGeometryDef(fs).handler({ project_slug: PROJECT, connector_id: "s0-source-swap", dx: -0.9, dy: 0.5 });
    expect(await readConnectors()).toEqual({ "s0-source-swap": { dx: -0.9, dy: 0.5 } });
  });

  it("resets (removes) a connector when dx and dy are both 0", async () => {
    await setPlanConnectorGeometryDef(fs).handler({ project_slug: PROJECT, connector_id: "s0-source-swap", dx: 0.3, dy: 0.2 });
    await setPlanConnectorGeometryDef(fs).handler({ project_slug: PROJECT, connector_id: "s0-swap-video", dx: -0.4, dy: 0 });
    await setPlanConnectorGeometryDef(fs).handler({ project_slug: PROJECT, connector_id: "s0-source-swap", dx: 0, dy: 0 });
    expect(await readConnectors()).toEqual({ "s0-swap-video": { dx: -0.4, dy: 0 } });
  });

  it("drops the connectors object entirely when the last connector resets", async () => {
    await setPlanConnectorGeometryDef(fs).handler({ project_slug: PROJECT, connector_id: "s0-source-swap", dx: 0.3, dy: 0.2 });
    await setPlanConnectorGeometryDef(fs).handler({ project_slug: PROJECT, connector_id: "s0-source-swap", dx: 0, dy: 0 });
    expect(await readConnectors()).toBeUndefined();
  });

  it("reset is a no-op when the connector was never set", async () => {
    const result = await setPlanConnectorGeometryDef(fs).handler({
      project_slug: PROJECT,
      connector_id: "s0-source-swap",
      dx: 0,
      dy: 0,
    });
    expect(result.isError).toBeFalsy();
    expect(await readConnectors()).toBeUndefined();
  });

  it("errors when there is no plan", async () => {
    await rm(join(tempDir, PROJECT, "plan", ".plan.json"), { force: true });
    const result = await setPlanConnectorGeometryDef(fs).handler({
      project_slug: PROJECT,
      connector_id: "s0-source-swap",
      dx: 0.2,
      dy: 0,
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0].text).toContain("No plan");
  });
});
