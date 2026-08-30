import type { Engine } from "videobook-engine";
import type {
  XPostFollowupError,
  XPostReplyResult,
} from "./post-contract.js";

export const POST_METADATA_FILE = ".post.x.json";
const POST_METADATA_VERSION = 2;

interface XPostEntry {
  tweet_id: string;
  tweet_url: string;
  posted_at: string;
  media_id: string;
  text: string | null;
  scheduled_for: string | null;
  schedule_id: string | null;
  status?: "posted" | "partially_posted";
  replies?: XPostReplyResult[];
  followup_error?: XPostFollowupError | null;
}

interface XPostMetadata {
  version: number;
  asset_id: string;
  posts: XPostEntry[];
}

function emptyMetadata(assetId: string): XPostMetadata {
  return { version: POST_METADATA_VERSION, asset_id: assetId, posts: [] };
}

async function readMetadata(
  engine: Engine,
  assetId: string,
): Promise<XPostMetadata> {
  const result = await engine.files.read(assetId, POST_METADATA_FILE);
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
  engine: Engine;
  assetId: string;
  entry: XPostEntry;
}): Promise<void> {
  const { engine, assetId, entry } = args;
  const existing = await readMetadata(engine, assetId);
  const next: XPostMetadata = {
    version: POST_METADATA_VERSION,
    asset_id: assetId,
    posts: [...existing.posts, entry],
  };
  const buffer = Buffer.from(JSON.stringify(next, null, 2), "utf8");
  const writeResult = await engine.files.write(assetId, POST_METADATA_FILE, buffer
  );
  if (!writeResult.ok) {
    throw new Error(
      `Failed to write ${POST_METADATA_FILE} for ${assetId}: ${writeResult.error.message}`,
    );
  }
}

export async function readXPostMetadata(
  engine: Engine,
  assetId: string,
): Promise<XPostMetadata> {
  return await readMetadata(engine, assetId);
}
