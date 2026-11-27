import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type CoverMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface CoverImage {
  bytes: Buffer;
  mimeType: CoverMimeType;
}

export interface CoverFetchPolicy {
  allowHttp?: boolean;
  allowPrivateHosts?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;

const ALLOWED_MIMES: ReadonlySet<string> = new Set<CoverMimeType>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function parseCoverMime(header: string | null): CoverMimeType | undefined {
  if (!header) return undefined;
  const mime = header.split(";")[0]?.trim().toLowerCase();
  return mime && ALLOWED_MIMES.has(mime) ? (mime as CoverMimeType) : undefined;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function expandIpv6(ip: string): number[] | undefined {
  const normalized = ip.toLowerCase();
  const zoneIndex = normalized.indexOf("%");
  const raw = zoneIndex >= 0 ? normalized.slice(0, zoneIndex) : normalized;
  let head = raw;
  let ipv4Tail: number[] | undefined;
  const lastColon = raw.lastIndexOf(":");
  if (lastColon >= 0 && raw.slice(lastColon + 1).includes(".")) {
    const v4 = raw.slice(lastColon + 1).split(".").map((part) => Number(part));
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
    ipv4Tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    head = raw.slice(0, lastColon);
  }
  const halves = head.split("::");
  if (halves.length > 2) return undefined;
  const parsePart = (text: string): number[] | undefined => {
    if (!text) return [];
    const groups = text.split(":");
    const values: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      values.push(parseInt(group, 16));
    }
    return values;
  };
  const left = parsePart(halves[0]);
  const right = halves.length === 2 ? parsePart(halves[1]) : [];
  if (!left || !right) return undefined;
  const tail = ipv4Tail ?? [];
  const total = left.length + right.length + tail.length;
  if (halves.length === 1) {
    return total === 8 ? [...left, ...tail] : undefined;
  }
  if (total > 8) return undefined;
  const zeros = Array<number>(8 - total).fill(0);
  return [...left, ...zeros, ...right, ...tail];
}

function isBlockedIpv6(ip: string): boolean {
  const words = expandIpv6(ip);
  if (!words) return true;
  const isAllZeroPrefix = words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0;
  if (isAllZeroPrefix && words[5] === 0 && words[6] === 0 && (words[7] === 0 || words[7] === 1)) {
    return true;
  }
  if (isAllZeroPrefix && words[5] === 0xffff) {
    const ipv4 = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
    return isBlockedIpv4(ipv4);
  }
  const first = words[0];
  if (first >= 0xfc00 && first <= 0xfdff) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}

function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (isIP(host) !== 0) return isBlockedIp(host);
  return false;
}

async function isAllowedUrl(rawUrl: string, policy: CoverFetchPolicy): Promise<URL | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const allowHttp = policy.allowHttp === true;
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    return undefined;
  }
  if (policy.allowPrivateHosts === true) {
    return parsed;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (isBlockedHostname(host)) {
    return undefined;
  }
  if (isIP(host) === 0) {
    try {
      const addresses = await lookup(host, { all: true });
      if (addresses.length === 0 || addresses.some((entry) => isBlockedIp(entry.address))) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  return parsed;
}

export async function fetchCoverImage(
  url: string,
  signal?: AbortSignal,
  policy: CoverFetchPolicy = {},
): Promise<CoverImage | undefined> {
  if (signal?.aborted) return undefined;
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = policy.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return undefined;
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Cover fetch timed out")), timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;

  try {
    let currentUrl = url;
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const target = await isAllowedUrl(currentUrl, policy);
      if (!target) return undefined;
      if (combinedSignal.aborted) return undefined;
      const res = await fetch(target, { signal: combinedSignal, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location || hop === MAX_REDIRECTS) return undefined;
        try {
          currentUrl = new URL(location, target).toString();
        } catch {
          return undefined;
        }
        continue;
      }
      response = res;
      break;
    }

    if (!response || !response.ok) {
      await response?.body?.cancel().catch(() => {});
      return undefined;
    }
    const mimeType = parseCoverMime(response.headers.get("content-type"));
    if (!mimeType) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        return undefined;
      }
    }

    if (!response.body) {
      const arrayBuf = await response.arrayBuffer();
      if (arrayBuf.byteLength === 0 || arrayBuf.byteLength > maxBytes) return undefined;
      return { bytes: Buffer.from(arrayBuf), mimeType };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          return undefined;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (totalBytes === 0) return undefined;
    return { bytes: Buffer.concat(chunks, totalBytes), mimeType };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
