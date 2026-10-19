import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_PACKAGE_NAME = "videobook-workspace";

export interface DataLayout {
  kind: "home" | "checkout";
  root: string;
  libraryDir: string;
  appStatePath: string;
  envPath: string;
}

function packageName(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

export function sourceCheckoutRoot(moduleUrl: string = import.meta.url): string | null {
  const root = resolve(dirname(fileURLToPath(moduleUrl)), "../..");
  return packageName(join(root, "package.json")) === WORKSPACE_PACKAGE_NAME ? root : null;
}

function homeLayout(root: string): DataLayout {
  return {
    kind: "home",
    root,
    libraryDir: join(root, "books"),
    appStatePath: join(root, "app-state.json"),
    envPath: join(root, ".env"),
  };
}

function checkoutLayout(root: string): DataLayout {
  return {
    kind: "checkout",
    root,
    libraryDir: join(root, "books"),
    appStatePath: join(root, "runtime", "app-state.json"),
    envPath: join(root, ".env"),
  };
}

export function dataLayout(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  checkoutRoot: string | null = sourceCheckoutRoot(),
): DataLayout {
  const home = env.VIDEOBOOK_HOME?.trim();
  if (home) return homeLayout(resolve(cwd, home));
  if (checkoutRoot) return checkoutLayout(checkoutRoot);
  return homeLayout(join(homedir(), ".videobook"));
}
