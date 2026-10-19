import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { sourceCheckoutRoot } from "../data-home.js";

interface BrowserStatus {
  type?: string;
  path?: string;
}

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const CACHE_PACKAGE = `${JSON.stringify({ name: "videobook-remotion-cache", private: true })}\n`;

let located: Promise<string | undefined> | undefined;

export function remotionCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  checkoutRoot: string | null = sourceCheckoutRoot(),
): string | null {
  const override = env.VIDEOBOOK_REMOTION_CACHE_DIR?.trim();
  if (override) return resolve(override);
  if (checkoutRoot) return null;
  return join(homedir(), ".cache", "videobook", "remotion");
}

export function remotionBrowserDir(root: string): string {
  return join(root, "node_modules", ".remotion");
}

function ensureBrowserScript(): string {
  const renderer = JSON.stringify(require.resolve("@remotion/renderer"));
  return `require(${renderer}).ensureBrowser({ chromeMode: "headless-shell", logLevel: "error" })`
    + ".then((status) => process.stdout.write(`\\n${JSON.stringify(status)}\\n`))";
}

function parseStatus(stdout: string): BrowserStatus {
  const line = stdout.trim().split("\n").pop() ?? "{}";
  try {
    return JSON.parse(line) as BrowserStatus;
  } catch {
    return {};
  }
}

async function locate(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), CACHE_PACKAGE, { flag: "w" });
  const { stdout } = await execFileAsync(process.execPath, ["-e", ensureBrowserScript()], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
  const status = parseStatus(stdout);
  if (typeof status.path !== "string") throw new Error(`Remotion could not provide a render browser (${status.type ?? "no status"})`);
  return status.path;
}

export function renderBrowserExecutable(): Promise<string | undefined> {
  const root = remotionCacheRoot();
  if (!root) return Promise.resolve(undefined);
  located ??= locate(root).catch((error: unknown) => {
    located = undefined;
    throw error;
  });
  return located;
}
