import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface Manifest {
  name: string;
  private?: boolean;
  type?: string;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: { node?: string };
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
}

const execFileAsync = promisify(execFile);
const serverRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(serverRoot, "..");
const PEER_FLOORS: ReadonlySet<string> = new Set(["hono", "react-dom"]);
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function globPattern(glob: string): RegExp {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*\*\//gu, "\u0000")
    .replace(/\*\*/gu, ".*")
    .replace(/\*/gu, "[^/]*")
    .replaceAll("\u0000", "(?:.*/)?");
  return new RegExp(`^${pattern}$`, "u");
}

async function buildExcludes(): Promise<RegExp[]> {
  const config = await readJson<{ exclude: string[] }>(join(serverRoot, "tsconfig.build.json"));
  return config.exclude.map(globPattern);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return Promise.resolve(/\.tsx?$/u.test(entry.name) ? [path] : []);
  }));
  return nested.flat();
}

async function shippableSources(): Promise<string[]> {
  const excludes = await buildExcludes();
  const files = await sourceFiles(join(serverRoot, "src"));
  return files.filter((file) => !excludes.some((pattern) => pattern.test(relative(serverRoot, file))));
}

function packageName(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? null;
}

function moduleSpecifier(node: ts.Node, source: ts.SourceFile): string | null {
  if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
  if (!ts.isCallExpression(node) || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) return null;
  const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  return dynamicImport || node.expression.getText(source) === "require" ? node.arguments[0].text : null;
}

async function runtimeImports(file: string): Promise<string[]> {
  const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node): void {
    const name = packageName(moduleSpecifier(node, source) ?? ".");
    if (name) found.push(name);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

async function importedPackages(): Promise<Map<string, string[]>> {
  const imported = new Map<string, string[]>();
  for (const file of await shippableSources()) {
    for (const name of await runtimeImports(file)) {
      imported.set(name, [...imported.get(name) ?? [], relative(serverRoot, file)]);
    }
  }
  return imported;
}

describe("published videobook package manifest", () => {
  it("publishes the server workspace as the videobook command", async () => {
    const manifest = await readJson<Manifest>(join(serverRoot, "package.json"));
    expect(manifest).toMatchObject({
      name: "videobook",
      type: "module",
      license: "MIT",
      bin: { videobook: "bin/videobook.js" },
      engines: { node: ">=22" },
    });
    expect(manifest.private).toBeUndefined();
    expect(manifest.files).toEqual(expect.arrayContaining(["bin", "dist", "ui", "CHANGELOG.md"]));
  });

  it("ships an executable shim that checks Node before loading the CLI", async () => {
    const shim = await readFile(join(serverRoot, "bin", "videobook.js"), "utf8");
    expect(shim.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(shim).toContain("../dist/cli/entry.js");
    const { stdout } = await execFileAsync("git", ["ls-files", "-s", "server/bin/videobook.js"], { cwd: repoRoot });
    expect(stdout.split(/\s+/u)[0]).toBe("100755");
  });

  it("declares every package that shippable server code imports, and nothing unused", async () => {
    const manifest = await readJson<Manifest>(join(serverRoot, "package.json"));
    const imported = await importedPackages();
    const undeclared = [...imported].filter(([name]) => !(name in manifest.dependencies)).map(([name, files]) => `${name} (${files[0]})`);
    expect(undeclared).toEqual([]);
    const unused = Object.keys(manifest.dependencies).filter((name) => !imported.has(name) && !PEER_FLOORS.has(name));
    expect(unused).toEqual([]);
  });

  it("pins the engine and its native modules to exactly one version", async () => {
    const server = await readJson<Manifest>(join(serverRoot, "package.json"));
    const root = await readJson<Manifest>(join(repoRoot, "package.json"));
    const engine = await readJson<Manifest>(join(repoRoot, "node_modules", "videobook-engine", "package.json"));
    expect(server.dependencies["videobook-engine"]).toMatch(EXACT_VERSION);
    expect(root.dependencies["videobook-engine"]).toBe(server.dependencies["videobook-engine"]);
    expect(server.dependencies.sharp).toBe(engine.dependencies.sharp);
    expect(root.overrides?.sharp).toBe(engine.dependencies.sharp);
    expect(root.devDependencies?.["@dolthub/doltlite"]).toBe(engine.dependencies["@dolthub/doltlite"]);
    expect(server.dependencies["@dolthub/doltlite"]).toBeUndefined();
  });

  it("builds with a config that leaves tests and test helpers out of the package", async () => {
    const shipped = (await shippableSources()).map((file) => relative(serverRoot, file));
    expect(shipped).toContain("src/cli/entry.ts");
    expect(shipped).toContain("src/test-queue-cleanup.ts");
    for (const helper of ["src/test-client.ts", "src/test-goals.ts", "src/test-media-fixtures.ts", "src/test-fetch-guard.ts", "src/tools/xai-realtime-endpoint.ts"]) {
      expect(shipped).not.toContain(helper);
    }
    expect(shipped.filter((file) => /\.test\.tsx?$/u.test(file) || file.startsWith("src/quiet-probes/"))).toEqual([]);
  });
});
