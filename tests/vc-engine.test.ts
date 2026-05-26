import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSandbox, type Sandbox } from './helpers/sandbox.js';

describe('vc-engine integration', () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await createSandbox();
  });

  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('create project and retrieve it', async () => {
    const result = await sandbox.fs.createProject('my-project');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slug).toBe('my-project');

    const get = await sandbox.fs.getProject('my-project');
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    expect(get.value.metadata.slug).toBe('my-project');
  });

  it('list multiple projects', async () => {
    await sandbox.fs.createProject('project-a');
    await sandbox.fs.createProject('project-b');

    const projects = await sandbox.fs.listProjects();
    const slugs = projects.map((p) => p.slug).sort();
    expect(slugs).toEqual(['project-a', 'project-b']);
  });

  it('create asset within project', async () => {
    const proj = await sandbox.fs.createProject('asset-test');
    if (!proj.ok) throw new Error(proj.error.message);

    const asset = await sandbox.fs.createAsset('vid', 'intro clip', 'asset-test');
    expect(asset.ok).toBe(true);
    if (!asset.ok) return;
    expect(asset.value.assetId).toMatch(/^vid-intro-clip/);

    const assets = await sandbox.fs.listAssets('asset-test');
    expect(assets.length).toBe(1);
    expect(assets[0].type).toBe('video');
  });

  it('write and read text file roundtrip', async () => {
    const proj = await sandbox.fs.createProject('text-test');
    if (!proj.ok) throw new Error(proj.error.message);

    const asset = await sandbox.fs.createAsset('img', 'banner', 'text-test');
    if (!asset.ok) throw new Error(asset.error.message);
    const assetId = asset.value.assetId;

    const content = 'Hello from clipfirst tests!';
    const write = await sandbox.fs.writeFile(assetId, 'notes.txt', content, 'text-test');
    expect(write.ok).toBe(true);

    const read = await sandbox.fs.readFile(assetId, 'notes.txt', 'text-test');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.toString('utf-8')).toBe(content);
  });

  it('binary data roundtrip', async () => {
    const proj = await sandbox.fs.createProject('binary-test');
    if (!proj.ok) throw new Error(proj.error.message);

    const asset = await sandbox.fs.createAsset('vid', 'clip', 'binary-test');
    if (!asset.ok) throw new Error(asset.error.message);
    const assetId = asset.value.assetId;

    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x80, 0x7f]);
    const write = await sandbox.fs.writeFile(assetId, 'data.bin', binary, 'binary-test');
    expect(write.ok).toBe(true);

    const read = await sandbox.fs.readFile(assetId, 'data.bin', 'binary-test');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Buffer.compare(read.value, binary)).toBe(0);
  });

  it('full workflow: project + assets + files + manifest + delete', async () => {
    const proj = await sandbox.fs.createProject('full-workflow');
    if (!proj.ok) throw new Error(proj.error.message);
    const slug = 'full-workflow';

    // Create two assets
    const vid = await sandbox.fs.createAsset('vid', 'main video', slug);
    if (!vid.ok) throw new Error(vid.error.message);
    const img = await sandbox.fs.createAsset('img', 'thumbnail', slug);
    if (!img.ok) throw new Error(img.error.message);

    // Write files to each
    await sandbox.fs.writeFile(vid.value.assetId, 'original.mp4', Buffer.from('fake-mp4'), slug);
    await sandbox.fs.writeFile(img.value.assetId, 'original.jpg', Buffer.from('fake-jpg'), slug);

    // Verify assets listed
    const assets = await sandbox.fs.listAssets(slug);
    expect(assets.length).toBe(2);

    // Check manifest for video asset
    const manifest = await sandbox.fs.getManifest(vid.value.assetId, slug);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.asset_id).toBe(vid.value.assetId);
    const fileNames = manifest.value.files.map((f) => f.name);
    expect(fileNames).toContain('original.mp4');

    // Delete the image asset
    const del = await sandbox.fs.deleteAsset(img.value.assetId, slug);
    expect(del.ok).toBe(true);

    // Only video remains
    const remaining = await sandbox.fs.listAssets(slug);
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(vid.value.assetId);
  });
});
