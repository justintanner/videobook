import type { SetupFlags } from "./args.js";
import { readEnvValues, updateEnvFile } from "../env-file.js";
import { MANAGED_ENV_KEYS, getDefaultSecretStore } from "../env-secrets.js";
import {
  OP_TOKEN_SETTING,
  OP_VAULT_SETTING,
  listVaultItemTitles,
  opErrorMessage,
  resolveServiceToken,
} from "../one-password.js";

type EnvValues = Readonly<Record<string, string>>;

const AMBIENT_TOKEN_VARIABLE = "OP_SERVICE_ACCOUNT_TOKEN";

function savedSetting(name: string, file: EnvValues): string | null {
  return process.env[name]?.trim() || file[name]?.trim() || null;
}

function chosenVault(flags: SetupFlags, file: EnvValues): string | null {
  return flags.vault?.trim() || savedSetting(OP_VAULT_SETTING, file);
}

function chosenToken(flags: SetupFlags, file: EnvValues): string | null {
  const explicit = flags.token?.trim() || savedSetting(OP_TOKEN_SETTING, file);
  if (explicit) return explicit;
  return process.env[AMBIENT_TOKEN_VARIABLE]?.trim() ? `env:${AMBIENT_TOKEN_VARIABLE}` : null;
}

function describeToken(token: string | null): string {
  if (!token) return "op's own sign-in";
  const resolved = resolveServiceToken(token, process.env);
  if (resolved.source === "literal") return "a literal token (stored in the file; prefer env:VAR)";
  return resolved.value ? token : `${token}, which is not set in this shell`;
}

async function removeSettings(envPath: string): Promise<number> {
  await updateEnvFile(envPath, { [OP_VAULT_SETTING]: null, [OP_TOKEN_SETTING]: null });
  process.stdout.write(`Removed ${OP_VAULT_SETTING} and ${OP_TOKEN_SETTING} from ${envPath}\n`);
  return 0;
}

function verifyVault(vault: string, token: string | null): number {
  const value = token ? resolveServiceToken(token, process.env).value : null;
  try {
    const titles = listVaultItemTitles(vault, process.env, value);
    const found = MANAGED_ENV_KEYS.filter((key) => titles.has(key));
    const missing = MANAGED_ENV_KEYS.filter((key) => !titles.has(key));
    process.stdout.write(`1Password vault ${vault}: ${found.length} of ${MANAGED_ENV_KEYS.length} videobook keys found\n`);
    if (missing.length > 0) process.stdout.write(`Not in the vault: ${missing.join(", ")}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Could not list 1Password vault ${vault}: ${opErrorMessage(error, value)}\n`);
    return 1;
  }
}

export async function runSetupCommand(flags: SetupFlags): Promise<number> {
  const envPath = getDefaultSecretStore().envPath();
  if (flags.remove) return removeSettings(envPath);
  const file = readEnvValues(envPath);
  const vault = chosenVault(flags, file);
  if (!vault) {
    process.stderr.write("setup 1password needs --op-vault <vault>, the vault whose items are named after videobook's keys\n");
    return 2;
  }
  const token = chosenToken(flags, file);
  await updateEnvFile(envPath, { [OP_VAULT_SETTING]: vault, [OP_TOKEN_SETTING]: token });
  process.stdout.write(`Saved ${OP_VAULT_SETTING}=${vault} and the token setting (${describeToken(token)}) to ${envPath}\n`);
  return flags.verify ? verifyVault(vault, token) : 0;
}
