import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandbox, type Sandbox } from "./helpers/sandbox.js";

describe("videobook-engine integration", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it("creates and retrieves a project", async () => {
    const created = await sandbox.engine.projects.create("my-project");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.slug).toBe("my-project");

    const found = sandbox.engine.projects.get(created.value.projectId);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.slug).toBe("my-project");
  });

  it("lists multiple projects", async () => {
    await sandbox.engine.projects.create("project-a");
    await sandbox.engine.projects.create("project-b");

    const slugs = sandbox.engine.projects.list().map((project) => project.slug).sort();
    expect(slugs).toEqual(["project-a", "project-b"]);
  });

  it("creates an artifact within a project", async () => {
    const project = await sandbox.engine.projects.create("artifact-test");
    if (!project.ok) throw new Error(project.error.message);

    const artifact = await sandbox.engine.artifacts.create("video", "intro clip", project.value.projectId);
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) return;
    expect(artifact.value.slug).toBe("vid-intro-clip");

    const artifacts = sandbox.engine.artifacts.list(project.value.projectId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind).toBe("video");
  });

  it("round-trips text and binary files through CAS", async () => {
    const project = await sandbox.engine.projects.create("file-test");
    if (!project.ok) throw new Error(project.error.message);
    const artifact = await sandbox.engine.artifacts.create("video", "clip", project.value.projectId);
    if (!artifact.ok) throw new Error(artifact.error.message);

    const text = "Hello from Dolt-native Videobook tests!";
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x80, 0x7f]);
    expect((await sandbox.engine.files.write(
      artifact.value.artifactId,
      "notes.txt",
      text,
      project.value.projectId,
    )).ok).toBe(true);
    expect((await sandbox.engine.files.write(
      artifact.value.artifactId,
      "data.bin",
      binary,
      project.value.projectId,
    )).ok).toBe(true);

    const readText = await sandbox.engine.files.read(
      artifact.value.artifactId,
      "notes.txt",
      project.value.projectId,
    );
    const readBinary = await sandbox.engine.files.read(
      artifact.value.artifactId,
      "data.bin",
      project.value.projectId,
    );
    expect(readText.ok && readText.value.toString("utf8")).toBe(text);
    expect(readBinary.ok && Buffer.compare(readBinary.value, binary)).toBe(0);
  });

  it("manifests files and reuses a deleted slug with a new identity", async () => {
    const project = await sandbox.engine.projects.create("full-workflow");
    if (!project.ok) throw new Error(project.error.message);
    const video = await sandbox.engine.artifacts.create("video", "main video", project.value.projectId);
    const image = await sandbox.engine.artifacts.create("image", "thumbnail", project.value.projectId);
    if (!video.ok) throw new Error(video.error.message);
    if (!image.ok) throw new Error(image.error.message);

    await sandbox.engine.files.write(
      video.value.artifactId,
      "original.mp4",
      Buffer.from("fake-mp4"),
      project.value.projectId,
    );
    const manifest = await sandbox.engine.files.manifest(
      video.value.artifactId,
      project.value.projectId,
    );
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.artifactId).toBe(video.value.artifactId);
    expect(manifest.value.files.map((file) => file.name)).toContain("original.mp4");

    expect((await sandbox.engine.artifacts.delete(
      image.value.artifactId,
      project.value.projectId,
    )).ok).toBe(true);
    const replacement = await sandbox.engine.artifacts.create({
      project: project.value.projectId,
      kind: "image",
      slug: image.value.slug,
    });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(replacement.value.slug).toBe(image.value.slug);
    expect(replacement.value.artifactId).not.toBe(image.value.artifactId);
  });
});
