import type { ConfigAction, ConfigFlags } from "./args.js";
import { hasControlCharacters, readEnvValues, updateEnvFile } from "../env-file.js";
import {
  MANAGED_ENV_KEYS,
  getDefaultSecretStore,
  isSecretEnvKey,
  maskEnvValue,
  type ManagedEnvKey,
} from "../env-secrets.js";
import { OP_TOKEN_SETTING, OP_VAULT_SETTING, isOpReference, vaultReference } from "../one-password.js";

type ConfigSource = "environment" | ".env" | "1password reference" | "1password vault" | "missing";

type EnvValues = Readonly<Record<string, string>>;

interface ConfigRow {
  key: string;
  source: ConfigSource;
  value: string | null;
}

interface ConfigCommand {
  action: ConfigAction;
  key: string | null;
  value: string | null;
  flags: ConfigFlags;
}

const SETTING_KEYS: readonly string[] = [OP_VAULT_SETTING, OP_TOKEN_SETTING];
const CONFIG_KEYS: readonly string[] = [...MANAGED_ENV_KEYS, ...SETTING_KEYS];
const TOKEN_VARIABLE_FORM = /^(env:|\$)?[A-Z_][A-Z0-9_]*$/u;

function isSecret(key: string): boolean {
  if (key === OP_VAULT_SETTING) return false;
  if (key === OP_TOKEN_SETTING) return true;
  return isSecretEnvKey(key as ManagedEnvKey);
}

function displayValue(key: string, value: string): string {
  if (isOpReference(value)) return value.trim();
  if (key === OP_TOKEN_SETTING && TOKEN_VARIABLE_FORM.test(value)) return value;
  return isSecret(key) ? maskEnvValue(value) : value;
}

function configuredVault(file: EnvValues): string | null {
  return process.env[OP_VAULT_SETTING]?.trim() || file[OP_VAULT_SETTING]?.trim() || null;
}

function configRow(key: string, file: EnvValues): ConfigRow {
  const shell = process.env[key]?.trim();
  if (shell) return { key, source: "environment", value: displayValue(key, shell) };
  const stored = file[key]?.trim();
  if (stored) return { key, source: isOpReference(stored) ? "1password reference" : ".env", value: displayValue(key, stored) };
  const vault = configuredVault(file);
  if (vault && !SETTING_KEYS.includes(key)) return { key, source: "1password vault", value: vaultReference(vault, key) };
  return { key, source: "missing", value: null };
}

function vaultNote(rows: ConfigRow[], vault: string | null): string {
  if (!vault || !rows.some((row) => row.source === "1password vault")) return "";
  return `\nKeys marked "1password vault" come from ${vault} when it has an item with that name; videobook doctor shows which do.\n`;
}

function printRows(rows: ConfigRow[], file: EnvValues, json: boolean, envPath: string): void {
  const vault = configuredVault(file);
  if (json) {
    process.stdout.write(`${JSON.stringify({ envPath, vault, keys: rows }, null, 2)}\n`);
    return;
  }
  const lines = rows.map((row) => `${row.key.padEnd(28)} ${row.source.padEnd(20)} ${row.value ?? ""}`.trimEnd());
  process.stdout.write(`${lines.join("\n")}\n${vaultNote(rows, vault)}`);
}

function knownKey(key: string): boolean {
  if (CONFIG_KEYS.includes(key)) return true;
  process.stderr.write(`${key} is not a videobook setting. Known keys: ${CONFIG_KEYS.join(", ")}\n`);
  return false;
}

function invalidValue(key: string, value: string): string | null {
  if (!value || hasControlCharacters(value)) return `${key} needs a non-empty value without control characters`;
  if (value.includes("'") && value.includes("\"")) return `${key} cannot contain both single and double quotes`;
  if (process.env[key]?.trim()) return `${key} is set in the environment, which overrides the .env file; change it where it is exported instead`;
  return null;
}

async function setKey(key: string, raw: string, envPath: string): Promise<number> {
  const value = raw.trim();
  const problem = invalidValue(key, value);
  if (problem) {
    process.stderr.write(`${problem}\n`);
    return 1;
  }
  await updateEnvFile(envPath, { [key]: value });
  process.stdout.write(`Set ${key}=${displayValue(key, value)} in ${envPath}\n`);
  return 0;
}

async function unsetKey(key: string, envPath: string): Promise<number> {
  const present = key in readEnvValues(envPath);
  if (present) await updateEnvFile(envPath, { [key]: null });
  process.stdout.write(present ? `Removed ${key} from ${envPath}\n` : `${key} was not set in ${envPath}\n`);
  if (process.env[key]?.trim()) process.stderr.write(`Note: ${key} is still set in the environment.\n`);
  return 0;
}

export async function runConfigCommand(command: ConfigCommand): Promise<number> {
  const envPath = getDefaultSecretStore().envPath();
  if (command.action === "list") {
    const file = readEnvValues(envPath);
    printRows(CONFIG_KEYS.map((key) => configRow(key, file)), file, command.flags.json, envPath);
    return 0;
  }
  const key = command.key ?? "";
  if (!knownKey(key)) return 1;
  if (command.action === "get") {
    const file = readEnvValues(envPath);
    printRows([configRow(key, file)], file, command.flags.json, envPath);
    return 0;
  }
  if (command.action === "set") return setKey(key, command.value ?? "", envPath);
  return unsetKey(key, envPath);
}
