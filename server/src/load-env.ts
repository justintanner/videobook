/**
 * Side-effect module replacing `import "dotenv/config"`. Import this FIRST in
 * every entry point: ESM executes it before the other imports' module bodies,
 * so env vars are populated before any module reads them at import time. It
 * also snapshots which managed keys were set before `.env` loaded, which is
 * how the secret store tells 1Password-injected keys from `.env`-backed ones,
 * then resolves op:// references and the configured vault through `op`.
 */
import { getDefaultSecretStore } from "./env-secrets.js";

const store = getDefaultSecretStore();
store.loadDotenv();
store.resolveOnePassword();
