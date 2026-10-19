import { getDefaultSecretStore } from "../env-secrets.js";

export function onePasswordSummary(): string | null {
  const resolution = getDefaultSecretStore().onePasswordResolution();
  if (!resolution?.attempted) return null;
  const filled = resolution.fromReferences.length + resolution.fromVault.length;
  const vault = resolution.vault ? ` (vault ${resolution.vault})` : "";
  return `${filled} key(s) from 1Password${vault}`;
}

export function onePasswordWarnings(): string[] {
  const resolution = getDefaultSecretStore().onePasswordResolution();
  if (!resolution?.attempted) return [];
  const failures = resolution.unresolved.map((item) => `could not resolve ${item.key} from ${item.reference}: ${item.reason}`);
  return resolution.error ? [resolution.error, ...failures] : failures;
}
