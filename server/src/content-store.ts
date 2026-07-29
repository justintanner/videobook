import { readFile, writeFile } from "node:fs/promises";

import { B2Error, createB2 } from "@apicity/b2";
import type { ContentStore } from "videobook-engine";

interface B2StoreConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  endpoint?: string;
  bucket: string;
}

export function createB2ContentStore(
  config: B2StoreConfig,
): ContentStore {
  const provider = createB2({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  });
  return {
    head: async (key) => {
      try {
        const result = await provider.objects.head({
          bucket: config.bucket,
          key,
        });
        return {
          exists: true,
          ...(result.contentLength !== undefined
            ? { size: result.contentLength }
            : {}),
        };
      } catch (error) {
        if (error instanceof B2Error && error.status === 404) {
          return { exists: false };
        }
        throw error;
      }
    },
    uploadFile: async (key, sourcePath) => {
      await provider.objects.put({
        bucket: config.bucket,
        key,
        body: await readFile(sourcePath),
        contentType: "application/octet-stream",
      });
    },
    downloadFile: async (key, destinationPath) => {
      const result = await provider.objects.get({
        bucket: config.bucket,
        key,
      });
      await writeFile(destinationPath, new Uint8Array(result.body));
    },
    delete: async (key) => {
      await provider.objects.del({
        bucket: config.bucket,
        key,
      });
    },
  };
}

export function contentStoreFromEnvironment(): ContentStore | undefined {
  const accessKeyId = process.env.B2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.B2_SECRET_ACCESS_KEY;
  const region = process.env.B2_REGION;
  const bucket = process.env.B2_BUCKET;
  if (!accessKeyId || !secretAccessKey || !region || !bucket) return undefined;
  return createB2ContentStore({
    accessKeyId,
    secretAccessKey,
    region,
    bucket,
    ...(process.env.B2_ENDPOINT
      ? { endpoint: process.env.B2_ENDPOINT }
      : {}),
  });
}
