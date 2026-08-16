import { bundle } from "@remotion/bundler";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";

const MODULE_PATH = fileURLToPath(import.meta.url);
const REMOTION_DIR = dirname(MODULE_PATH);
const REMOTION_ENTRY = join(
  REMOTION_DIR,
  extname(MODULE_PATH) === ".js" ? "index.js" : "index.tsx",
);
const REMOTION_PUBLIC_DIR = join(REMOTION_DIR, "public");

let bundleLocation: string | null = null;
let bundlePromise: Promise<string> | null = null;

export async function getSharedBundleLocation(): Promise<string> {
  if (bundleLocation) return bundleLocation;

  if (bundlePromise) return bundlePromise;

  bundlePromise = bundle({
    entryPoint: REMOTION_ENTRY,
    publicDir: REMOTION_PUBLIC_DIR,
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
