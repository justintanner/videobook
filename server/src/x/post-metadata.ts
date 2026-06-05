import type { VideocityFs } from "vc-engine";

export const POST_METADATA_FILE = ".post.x.json";
const POST_METADATA_VERSION = 1;

export interface XPostEntry {
  tweet_id: string;
  tweet_url: string;
  posted_at: string;
  media_id: string;
  text: string | null;
  scheduled_for: string | null;
  schedule_id: string | null;
}

export interface XPostMetadata {
  version: number;
  asset_id: string;
  posts: XPostEntry[];
}

function emptyMetadata(assetId: string): XPostMetadata {
  return { version: POST_METADATA_VERSION, asset_id: assetId, posts: [] };
}

async function readMetadata(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
): Promise<XPostMetadata> {
  const result = await fs.readFile(assetId, POST_METADATA_FILE, projectSlug);
  if (!result.ok) return emptyMetadata(assetId);
  try {
    const parsed = JSON.parse(result.value.toString("utf8")) as Partial<XPostMetadata>;
    if (
      parsed
      && typeof parsed === "object"
      && Array.isArray(parsed.posts)
      && typeof parsed.asset_id === "string"
    ) {
      return {
        version: typeof parsed.version === "number" ? parsed.version : POST_METADATA_VERSION,
        asset_id: parsed.asset_id,
        posts: parsed.posts as XPostEntry[],
      };
    }
    return emptyMetadata(assetId);
  } catch {
    return emptyMetadata(assetId);
  }
}

export async function appendXPostMetadata(args: {
  fs: VideocityFs;
  assetId: string;
  projectSlug: string;
  entry: XPostEntry;
}): Promise<void> {
  const { fs, assetId, projectSlug, entry } = args;
  const existing = await readMetadata(fs, assetId, projectSlug);
  const next: XPostMetadata = {
    version: POST_METADATA_VERSION,
    asset_id: assetId,
    posts: [...existing.posts, entry],
  };
  const buffer = Buffer.from(JSON.stringify(next, null, 2), "utf8");
  const writeResult = await fs.writeFile(
    assetId,
    POST_METADATA_FILE,
    buffer,
    projectSlug,
  );
  if (!writeResult.ok) {
    throw new Error(
      `Failed to write ${POST_METADATA_FILE} for ${assetId}: ${writeResult.error.message}`,
    );
  }
}

export async function readXPostMetadata(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
): Promise<XPostMetadata> {
  return await readMetadata(fs, assetId, projectSlug);
}
