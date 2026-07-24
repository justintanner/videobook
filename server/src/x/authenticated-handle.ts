/**
 * Read the authenticated X user's handle via @apicity/x's /2/users/me endpoint.
 *
 * Returns the handle (no leading @) or null when no token is configured, the
 * API rejects, or the response is malformed. Callers should treat null as
 * "unknown" and fall back to a cached value or prompt the user.
 */

import type { Engine } from "videobook-engine";
import { createX } from "@apicity/x";
import { getValidAccessToken } from "./x-tokens.js";
import { normalizeHandle } from "../watermark-config.js";

export async function fetchAuthenticatedXHandle(
  fs?: Engine,
): Promise<string | null> {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(
      fs ? { engine: fs } : {},
    );
  } catch {
    return null;
  }

  try {
    const x = createX({ accessToken });
    const res = await x.get.v2.users.me({ "user.fields": ["username"] });
    const username = res?.data?.username;
    if (typeof username !== "string") return null;
    return normalizeHandle(username);
  } catch {
    return null;
  }
}
