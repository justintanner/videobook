/**
 * The connected X account's subscription tier, which decides how long a post
 * may be: X gives every Premium tier (Basic, Premium, Premium+) long posts of
 * up to 25,000 characters, while unsubscribed accounts keep 280.
 *
 * The tier is read from /2/users/me and cached in the application credential
 * store next to the OAuth tokens, so posting never spends an extra API call.
 * Callers refresh it after a new authorization or on explicit request.
 */

import { createX } from "../usage-providers.js";
import { appState, type ApplicationStateStore } from "../app-state.js";
import { getValidAccessToken } from "./x-tokens.js";

export const X_POST_MAX_CHARACTERS = 280;
export const X_PREMIUM_POST_MAX_CHARACTERS = 25_000;

const SETTINGS_KEY = "x.account";
const SUBSCRIPTION_TYPES = ["None", "Basic", "Premium", "PremiumPlus"] as const;

export type XSubscriptionType = (typeof SUBSCRIPTION_TYPES)[number];

interface XAccountState {
  username: string;
  subscription_type: XSubscriptionType;
  fetched_at: string;
}

interface XAccountOptions {
  fetchImpl?: typeof fetch;
  store?: ApplicationStateStore;
}

function isXSubscriptionType(value: unknown): value is XSubscriptionType {
  return typeof value === "string"
    && (SUBSCRIPTION_TYPES as readonly string[]).includes(value);
}

/** Whether a tier unlocks long posts. Every paid tier does. */
function xAccountHasLongPosts(subscription: XSubscriptionType | null): boolean {
  return subscription !== null && subscription !== "None";
}

export function xPostMaxCharacters(subscription: XSubscriptionType | null): number {
  return xAccountHasLongPosts(subscription)
    ? X_PREMIUM_POST_MAX_CHARACTERS
    : X_POST_MAX_CHARACTERS;
}

function parseAccountState(value: unknown): XAccountState | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.username !== "string"
    || !isXSubscriptionType(record.subscription_type)
    || typeof record.fetched_at !== "string"
  ) {
    return null;
  }
  return {
    username: record.username,
    subscription_type: record.subscription_type,
    fetched_at: record.fetched_at,
  };
}

export async function readXAccount(
  store: ApplicationStateStore = appState,
): Promise<XAccountState | null> {
  return parseAccountState(await store.get<unknown>(SETTINGS_KEY));
}

export async function clearXAccount(
  store: ApplicationStateStore = appState,
): Promise<void> {
  await store.set(SETTINGS_KEY, null);
}

/** Ask X who the token belongs to and cache the answer. */
export async function fetchXAccount(
  options: XAccountOptions = {},
): Promise<XAccountState> {
  const store = options.store ?? appState;
  const fetchImpl = options.fetchImpl ?? fetch;
  const accessToken = await getValidAccessToken({ fetchImpl, store });
  const x = createX({ accessToken, fetch: fetchImpl });
  const response = await x.get.v2.users.me({
    "user.fields": ["username", "subscription_type"],
  });
  const username = response?.data?.username;
  if (typeof username !== "string" || username.trim() === "") {
    throw new Error("X did not return the connected account's username");
  }
  const subscription = response.data.subscription_type;
  const account: XAccountState = {
    username: username.replace(/^@/, "").trim(),
    subscription_type: isXSubscriptionType(subscription) ? subscription : "None",
    fetched_at: new Date().toISOString(),
  };
  await store.set(SETTINGS_KEY, account);
  return account;
}

/**
 * The cached account, fetched once when nothing is cached or when asked to
 * refresh. A failed lookup keeps whatever was cached; null means unknown.
 */
export async function resolveXAccount(
  options: XAccountOptions & { refresh?: boolean } = {},
): Promise<XAccountState | null> {
  const store = options.store ?? appState;
  const cached = await readXAccount(store);
  if (cached && !options.refresh) return cached;
  try {
    return await fetchXAccount({ store, fetchImpl: options.fetchImpl });
  } catch {
    return cached;
  }
}
