import { bundle } from "@remotion/bundler";

const REMOTION_ENTRY = new URL("../remotion/index.tsx", import.meta.url).pathname;

let bundleLocation: string | null = null;
let bundlePromise: Promise<string> | null = null;

export async function getSharedBundleLocation(): Promise<string> {
  if (bundleLocation) return bundleLocation;

  if (bundlePromise) return bundlePromise;

  bundlePromise = bundle({
    entryPoint: REMOTION_ENTRY,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        extensions: [".tsx", ".ts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
        extensionAlias: {
          ".js": [".tsx", ".ts", ".js"],
        },
      },
    }),
  }).then((location) => {
    bundleLocation = location;
    bundlePromise = null;
    return location;
  }).catch((err) => {
    bundlePromise = null;
    throw err;
  });

  return bundlePromise;
}

export function _resetBundleCache(): void {
  bundleLocation = null;
  bundlePromise = null;
}
