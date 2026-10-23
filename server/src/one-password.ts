import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OP_VAULT_SETTING = "VIDEOBOOK_OP_VAULT";
export const OP_TOKEN_SETTING = "VIDEOBOOK_OP_SERVICE_TOKEN";
const OP_TIMEOUT_MS = 10_000;
const TEMPLATE_UNSAFE = /[\r\n]|\{\{|\}\}/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface ServiceToken {
  value: string | null;
  source: string | null;
}

export interface OnePasswordSettings {
  vault: string | null;
  token: ServiceToken;
}

export interface UnresolvedReference {
  key: string;
  reference: string;
  reason: string;
}

export interface OnePasswordResolution {
  attempted: boolean;
  vault: string | null;
  tokenSource: string | null;
  fromReferences: string[];
  fromVault: string[];
  unresolved: UnresolvedReference[];
  error: string | null;
}

export interface ReferencePlan {
  explicit: Array<[string, string]>;
  convention: Array<[string, string]>;
}

interface InjectionResult {
  values: Map<string, string>;
  failures: UnresolvedReference[];
}

export function isOpReference(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().startsWith("op://");
}

export function vaultReference(vault: string, key: string): string {
  return `op://${vault}/${key}/password`;
}

export function resolveServiceToken(raw: string | undefined, env: NodeJS.ProcessEnv): ServiceToken {
  const value = raw?.trim();
  if (!value) return { value: null, source: null };
  const name = value.startsWith("env:") ? value.slice(4) : value.startsWith("$") ? value.slice(1) : value;
  if (value !== name || /^[A-Z_][A-Z0-9_]*$/u.test(value)) {
    if (!ENV_NAME.test(name)) return { value: null, source: `env:${name}` };
    return { value: env[name]?.trim() || null, source: `env:${name}` };
  }
  return { value, source: "literal" };
}

export function readOnePasswordSettings(env: NodeJS.ProcessEnv): OnePasswordSettings {
  return {
    vault: env[OP_VAULT_SETTING]?.trim() || null,
    token: resolveServiceToken(env[OP_TOKEN_SETTING], env),
  };
}

export function redactToken(text: string, token: string | null): string {
  return token ? text.split(token).join("***") : text;
}

/** Every vault item titled like an environment variable fills that variable, except the vault settings themselves. */
function isVaultEnvTitle(title: string): boolean {
  return ENV_NAME.test(title) && title !== OP_VAULT_SETTING && title !== OP_TOKEN_SETTING;
}

export function planReferences(
  env: NodeJS.ProcessEnv,
  vault: string | null,
  vaultTitles: ReadonlySet<string>,
): ReferencePlan {
  const explicit = Object.entries(env)
    .filter((entry): entry is [string, string] => isOpReference(entry[1]))
    .map(([key, reference]): [string, string] => [key, reference.trim()]);
  const covered = new Set(explicit.map(([key]) => key));
  const convention = vault
    ? [...vaultTitles]
      .filter((key) => isVaultEnvTitle(key) && !covered.has(key) && !env[key]?.trim())
      .sort()
      .map((key): [string, string] => [key, vaultReference(vault, key)])
    : [];
  return { explicit, convention };
}

function startMarker(nonce: string, key: string): string {
  return `<<<${nonce}:${key}>>>`;
}

function endMarker(nonce: string, key: string): string {
  return `<<<${nonce}/${key}>>>`;
}

export function injectionTemplate(entries: ReadonlyArray<[string, string]>, nonce: string): string {
  return entries.map(([key, reference]) => `${startMarker(nonce, key)}{{ ${reference} }}${endMarker(nonce, key)}`).join("\n");
}

export function parseInjection(output: string, keys: readonly string[], nonce: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const key of keys) {
    const start = output.indexOf(startMarker(nonce, key));
    if (start < 0) continue;
    const from = start + startMarker(nonce, key).length;
    const end = output.indexOf(endMarker(nonce, key), from);
    if (end < 0) continue;
    const value = output.slice(from, end);
    if (value !== "") values.set(key, value);
  }
  return values;
}

function opEnvironment(env: NodeJS.ProcessEnv, token: string | null): NodeJS.ProcessEnv {
  return token ? { ...env, OP_SERVICE_ACCOUNT_TOKEN: token } : env;
}

export function opErrorMessage(error: unknown, token: string | null): string {
  const failure = error as NodeJS.ErrnoException & { stderr?: string; signal?: string };
  if (failure.code === "ENOENT") return "the 1Password CLI (op) is not on PATH";
  if (failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM") return "op timed out";
  const line = String(failure.stderr ?? "").trim().split("\n")[0]?.trim().replace(/^\[ERROR\]\s+\S+\s+\S+\s+/u, "");
  return redactToken(line || failure.message || "op failed", token);
}

function runOp(args: string[], env: NodeJS.ProcessEnv, token: string | null): string {
  return execFileSync("op", args, {
    env: opEnvironment(env, token),
    encoding: "utf8",
    timeout: OP_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function listVaultItemTitles(vault: string, env: NodeJS.ProcessEnv, token: string | null): Set<string> {
  const parsed = JSON.parse(runOp(["item", "list", "--vault", vault, "--format", "json"], env, token)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("op item list did not return a list");
  return new Set(parsed.flatMap((item: unknown) => {
    const title = item && typeof item === "object" ? (item as { title?: unknown }).title : undefined;
    return typeof title === "string" ? [title] : [];
  }));
}

function injectBatch(entries: ReadonlyArray<[string, string]>, env: NodeJS.ProcessEnv, token: string | null): Map<string, string> {
  const nonce = randomUUID().replaceAll("-", "");
  const directory = mkdtempSync(join(tmpdir(), "videobook-op-"));
  try {
    const template = join(directory, "template");
    writeFileSync(template, injectionTemplate(entries, nonce), { mode: 0o600 });
    const output = runOp(["inject", "--in-file", template], env, token);
    return parseInjection(output, entries.map(([key]) => key), nonce);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function readOne(key: string, reference: string, env: NodeJS.ProcessEnv, token: string | null): InjectionResult {
  try {
    const value = runOp(["read", "--no-newline", reference], env, token);
    return value === ""
      ? { values: new Map(), failures: [{ key, reference, reason: "the item has no value" }] }
      : { values: new Map([[key, value]]), failures: [] };
  } catch (error) {
    return { values: new Map(), failures: [{ key, reference, reason: opErrorMessage(error, token) }] };
  }
}

function mergeResults(results: InjectionResult[]): InjectionResult {
  return {
    values: new Map(results.flatMap((result) => [...result.values])),
    failures: results.flatMap((result) => result.failures),
  };
}

function resolveEntries(entries: ReadonlyArray<[string, string]>, env: NodeJS.ProcessEnv, token: string | null): InjectionResult {
  const unsafe = entries.filter(([, reference]) => TEMPLATE_UNSAFE.test(reference));
  const safe = entries.filter(([, reference]) => !TEMPLATE_UNSAFE.test(reference));
  const refused = unsafe.map(([key, reference]) => ({ key, reference, reason: "malformed op:// reference" }));
  if (safe.length === 0) return { values: new Map(), failures: refused };
  try {
    const values = injectBatch(safe, env, token);
    const missing = safe.filter(([key]) => !values.has(key)).map(([key, reference]) => ({ key, reference, reason: "op inject returned no value" }));
    return { values, failures: [...refused, ...missing] };
  } catch {
    const individual = mergeResults(safe.map(([key, reference]) => readOne(key, reference, env, token)));
    return { values: individual.values, failures: [...refused, ...individual.failures] };
  }
}

function vaultTitles(settings: OnePasswordSettings, env: NodeJS.ProcessEnv): { titles: Set<string>; error: string | null } {
  if (!settings.vault) return { titles: new Set(), error: null };
  try {
    return { titles: listVaultItemTitles(settings.vault, env, settings.token.value), error: null };
  } catch (error) {
    return { titles: new Set(), error: `could not list vault ${settings.vault}: ${opErrorMessage(error, settings.token.value)}` };
  }
}

function emptyResolution(settings: OnePasswordSettings): OnePasswordResolution {
  return {
    attempted: false,
    vault: settings.vault,
    tokenSource: settings.token.source,
    fromReferences: [],
    fromVault: [],
    unresolved: [],
    error: null,
  };
}

export function resolveOnePasswordEnv(env: NodeJS.ProcessEnv): OnePasswordResolution {
  const settings = readOnePasswordSettings(env);
  const hasReferences = Object.values(env).some((value) => isOpReference(value));
  if (!hasReferences && !settings.vault) return emptyResolution(settings);
  const listing = vaultTitles(settings, env);
  const plan = planReferences(env, settings.vault, listing.titles);
  const result = resolveEntries([...plan.explicit, ...plan.convention], env, settings.token.value);
  for (const [key] of plan.explicit) {
    const value = result.values.get(key);
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  for (const [key] of plan.convention) {
    const value = result.values.get(key);
    if (value !== undefined) env[key] = value;
  }
  return {
    ...emptyResolution(settings),
    attempted: true,
    fromReferences: plan.explicit.map(([key]) => key).filter((key) => result.values.has(key)),
    fromVault: plan.convention.map(([key]) => key).filter((key) => result.values.has(key)),
    unresolved: result.failures,
    error: listing.error,
  };
}
