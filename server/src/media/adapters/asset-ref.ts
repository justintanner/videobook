import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Engine } from "videobook-engine";

const ASSET_SCHEME = "asset://";

export function assetRef(assetId: string, filename: string): string {
  return `${ASSET_SCHEME}${assetId}/${filename}`;
}

export async function readAssetRef(engine: Engine, ref: string): Promise<{ bytes: Buffer<ArrayBuffer>; filename: string }> {
  if (!ref.startsWith(ASSET_SCHEME)) throw new Error(`Not a book asset reference: ${ref}`);
  const [assetId, ...rest] = ref.slice(ASSET_SCHEME.length).split("/");
  const filename = rest.join("/");
  const dir = await engine.workspaces.resolveArtifact(assetId!);
  if (!dir.ok) throw new Error(dir.error.message);
  return { bytes: await readFile(join(dir.value, filename)), filename };
}
