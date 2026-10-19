import { resolve } from "node:path";
import { parseArgs } from "node:util";

export type LogLevelName = "silent" | "error" | "warn" | "info" | "debug";

export interface GlobalFlags {
  port?: number;
  library?: string;
  home?: string;
  logLevel?: LogLevelName;
}

export interface ServeFlags extends GlobalFlags {
  ui: boolean;
  open: boolean;
}

export interface RunFlags extends GlobalFlags {
  wait: boolean;
  timeoutSeconds: number;
}

export interface DoctorFlags extends GlobalFlags {
  json: boolean;
}

export interface SetupFlags extends GlobalFlags {
  vault?: string;
  token?: string;
  verify: boolean;
  remove: boolean;
}

export interface ConfigFlags extends GlobalFlags {
  json: boolean;
}

export type ConfigAction = "list" | "get" | "set" | "unset";

export type ParsedCli =
  | { command: "serve"; flags: ServeFlags }
  | { command: "mcp"; flags: GlobalFlags }
  | { command: "run"; flags: RunFlags; tool: string; toolArgs: Record<string, unknown> }
  | { command: "tools"; flags: GlobalFlags }
  | { command: "gc-books"; flags: GlobalFlags }
  | { command: "doctor"; flags: DoctorFlags }
  | { command: "setup"; target: "1password"; flags: SetupFlags }
  | { command: "config"; action: ConfigAction; key: string | null; value: string | null; flags: ConfigFlags }
  | { command: "version" }
  | { command: "help" };

export type CommandName = Exclude<ParsedCli["command"], "version" | "help">;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

type OptionSpec = { type: "string" | "boolean"; short?: string };

const LOG_LEVELS: ReadonlySet<string> = new Set(["silent", "error", "warn", "info", "debug"]);
const COMMANDS: ReadonlySet<string> = new Set(["serve", "mcp", "run", "tools", "gc-books", "doctor", "setup", "config", "version", "help"]);
const CONFIG_ACTIONS: ReadonlySet<string> = new Set(["list", "get", "set", "unset"]);
const POSITIONAL_COMMANDS: ReadonlySet<string> = new Set(["run", "setup", "config"]);
const DEFAULT_RUN_TIMEOUT_SECONDS = 600;

const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  port: { type: "string" },
  library: { type: "string" },
  home: { type: "string" },
  "log-level": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

const COMMAND_OPTIONS: Record<CommandName, Record<string, OptionSpec>> = {
  serve: { headless: { type: "boolean" }, "no-ui": { type: "boolean" }, open: { type: "boolean" } },
  mcp: {},
  run: { wait: { type: "boolean" }, "no-wait": { type: "boolean" }, timeout: { type: "string" } },
  tools: {},
  "gc-books": {},
  doctor: { json: { type: "boolean" } },
  setup: { "op-vault": { type: "string" }, "op-token": { type: "string" }, "no-verify": { type: "boolean" }, remove: { type: "boolean" } },
  config: { json: { type: "boolean" } },
};

type ParsedValues = Record<string, string | boolean | undefined>;

function splitCommand(argv: string[]): { command: string; rest: string[] } {
  const [first, ...rest] = argv;
  if (first === undefined || first.startsWith("-")) return { command: "serve", rest: argv };
  if (!COMMANDS.has(first)) throw new CliUsageError(`Unknown command "${first}".`);
  return { command: first, rest };
}

function parsePort(raw: string | boolean | undefined): number | undefined {
  if (typeof raw !== "string") return undefined;
  const port = Number(raw);
  if (!/^\d+$/u.test(raw) || port > 65535) throw new CliUsageError(`--port must be an integer from 0 to 65535, got "${raw}".`);
  return port;
}

function parseLogLevel(raw: string | boolean | undefined): LogLevelName | undefined {
  if (typeof raw !== "string") return undefined;
  if (!LOG_LEVELS.has(raw)) throw new CliUsageError(`--log-level must be one of silent, error, warn, info, debug; got "${raw}".`);
  return raw as LogLevelName;
}

function parseTimeout(raw: string | boolean | undefined): number {
  if (typeof raw !== "string") return DEFAULT_RUN_TIMEOUT_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new CliUsageError(`--timeout must be a positive number of seconds, got "${raw}".`);
  return seconds;
}

function stringValue(raw: string | boolean | undefined): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

function globalFlags(values: ParsedValues): GlobalFlags {
  const flags: GlobalFlags = {};
  const port = parsePort(values.port);
  const library = stringValue(values.library);
  const home = stringValue(values.home);
  const logLevel = parseLogLevel(values["log-level"]);
  if (port !== undefined) flags.port = port;
  if (library !== undefined) flags.library = library;
  if (home !== undefined) flags.home = home;
  if (logLevel !== undefined) flags.logLevel = logLevel;
  return flags;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function parseToolArgs(pairs: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new CliUsageError(`Invalid tool argument "${pair}". Use key=value.`);
    args[pair.slice(0, eq)] = parseValue(pair.slice(eq + 1));
  }
  return args;
}

function parseCommandArgs(command: CommandName, rest: string[]): { values: ParsedValues; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...COMMAND_OPTIONS[command] },
      allowPositionals: POSITIONAL_COMMANDS.has(command),
      strict: true,
    });
    return { values: parsed.values as ParsedValues, positionals: parsed.positionals };
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

function buildSetup(values: ParsedValues, positionals: string[], flags: GlobalFlags): ParsedCli {
  const [target, ...extra] = positionals;
  if (target !== "1password" || extra.length > 0) throw new CliUsageError("setup needs a target: videobook setup 1password --op-vault <vault> [--op-token env:OP_SERVICE_ACCOUNT_TOKEN]");
  const vault = stringValue(values["op-vault"]);
  const token = stringValue(values["op-token"]);
  return {
    command: "setup",
    target,
    flags: {
      ...flags,
      ...(vault === undefined ? {} : { vault }),
      ...(token === undefined ? {} : { token }),
      verify: values["no-verify"] !== true,
      remove: values.remove === true,
    },
  };
}

function buildConfig(values: ParsedValues, positionals: string[], flags: GlobalFlags): ParsedCli {
  const [action = "list", key, value, ...extra] = positionals;
  if (!CONFIG_ACTIONS.has(action)) throw new CliUsageError(`Unknown config action "${action}". Use list, get, set or unset.`);
  const needsKey = action !== "list";
  const needsValue = action === "set";
  const expected = 1 + (needsKey ? 1 : 0) + (needsValue ? 1 : 0);
  if (positionals.length > Math.max(expected, 1) || extra.length > 0 || (needsKey && !key) || (needsValue && value === undefined)) {
    throw new CliUsageError("Usage: videobook config list | get <KEY> | set <KEY> <VALUE> | unset <KEY>");
  }
  return {
    command: "config",
    action: action as ConfigAction,
    key: key ?? null,
    value: value ?? null,
    flags: { ...flags, json: values.json === true },
  };
}

function buildCommand(command: CommandName, values: ParsedValues, positionals: string[]): ParsedCli {
  const flags = globalFlags(values);
  switch (command) {
    case "serve":
      return { command, flags: { ...flags, ui: values.headless !== true && values["no-ui"] !== true, open: values.open === true } };
    case "run": {
      const [tool, ...pairs] = positionals;
      if (!tool) throw new CliUsageError("run needs a tool name, for example: videobook run list_books");
      return { command, tool, toolArgs: parseToolArgs(pairs), flags: { ...flags, wait: values["no-wait"] !== true, timeoutSeconds: parseTimeout(values.timeout) } };
    }
    case "doctor":
      return { command, flags: { ...flags, json: values.json === true } };
    case "setup":
      return buildSetup(values, positionals, flags);
    case "config":
      return buildConfig(values, positionals, flags);
    default:
      return { command, flags };
  }
}

export function parseCli(argv: string[]): ParsedCli {
  const { command, rest } = splitCommand(argv);
  if (command === "help") return { command: "help" };
  if (command === "version") return { command: "version" };
  const name = command as CommandName;
  const { values, positionals } = parseCommandArgs(name, rest);
  if (values.help === true) return { command: "help" };
  if (values.version === true) return { command: "version" };
  return buildCommand(name, values, positionals);
}

const HOME_DERIVED_ENV = ["VIDEOBOOK_LIBRARY_DIR", "VIDEOBOOK_APP_STATE_PATH", "VIDEOBOOK_ENV_PATH"] as const;

function applyHome(home: string, env: NodeJS.ProcessEnv, cwd: string): void {
  env.VIDEOBOOK_HOME = resolve(cwd, home);
  for (const name of HOME_DERIVED_ENV) delete env[name];
}

export function applyFlagsToEnv(flags: GlobalFlags, env: NodeJS.ProcessEnv, cwd: string): void {
  if (flags.home !== undefined) applyHome(flags.home, env, cwd);
  if (flags.library !== undefined) env.VIDEOBOOK_LIBRARY_DIR = resolve(cwd, flags.library);
  if (flags.port !== undefined) env.PORT = String(flags.port);
  if (flags.logLevel !== undefined) env.VIDEOBOOK_LOG_LEVEL = flags.logLevel;
}

export function resolvePort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT?.trim();
  const port = raw ? Number(raw) : 3001;
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 3001;
}

export function helpText(): string {
  return [
    "Usage: videobook [command] [options]",
    "",
    "Commands:",
    "  serve              Run the MCP server with the web UI (default)",
    "  mcp                Serve MCP over stdio for agent hosts such as Claude Code",
    "  run <tool> [k=v]   Call one MCP tool and print its result",
    "  tools              List the MCP tools and their parameters",
    "  gc-books           Reclaim catalog storage in every book",
    "  doctor             Check Node, media binaries, native modules and keys",
    "  config [action]    list | get <KEY> | set <KEY> <VALUE> | unset <KEY> in the data-home .env",
    "  setup 1password    Read keys from a 1Password vault (--op-vault, --op-token)",
    "  version            Print versions",
    "  help               Print this help",
    "",
    "Options:",
    "  --port <n>         HTTP port on 127.0.0.1 (default 3001, or PORT)",
    "  --library <dir>    Book library directory (default <data home>/books)",
    "  --home <dir>       Data home (default ~/.videobook, or VIDEOBOOK_HOME)",
    "  --log-level <l>    silent, error, warn, info or debug",
    "  --headless         serve: MCP and API only, no web UI (alias --no-ui)",
    "  --open             serve: open the web UI in a browser",
    "  --no-wait          run: do not wait for queued jobs",
    "  --timeout <s>      run: seconds to wait for jobs (default 600)",
    "  --json             doctor, config: print machine-readable results",
    "  --op-vault <name>  setup 1password: vault whose items are named after the keys",
    "  --op-token <tok>   setup 1password: service-account token, best as env:VAR",
    "  --no-verify        setup 1password: skip the op item list check",
    "  --remove           setup 1password: remove the saved 1Password settings",
    "  -v, --version      Print versions",
    "  -h, --help         Print this help",
    "",
    "Agent hosts:  claude mcp add videobook -- videobook mcp",
    "",
  ].join("\n");
}
