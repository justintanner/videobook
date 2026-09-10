import type { RequestHandler } from "express";

export const EXTENSION_ORIGIN = "chrome-extension://cebmihgcglhadjckbebmfahaiiljhgdj";

function localHost(host: string): boolean {
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host);
  return match !== null && (match[2] === undefined || Number(match[2]) <= 65535);
}

function localOrigin(origin: string): boolean {
  if (origin === EXTENSION_ORIGIN) return true;
  const match = /^https?:\/\/(.+)$/.exec(origin);
  return match !== null && localHost(match[1]);
}

export function allowsHttpRequest(
  host: string,
  origin: string | null,
  fetchSite: string | null,
): boolean {
  if (!localHost(host)) return false;
  if (origin !== null) return localOrigin(origin);
  return fetchSite !== "cross-site";
}

export const restrictHttpAccess: RequestHandler = (req, res, next) => {
  if (!allowsHttpRequest(
    req.get("host") ?? "",
    req.get("origin") ?? null,
    req.get("sec-fetch-site") ?? null,
  )) {
    res.status(403).json({ error: "HTTP request origin or host is not allowed" });
    return;
  }
  next();
};

export const restrictMediaContent: RequestHandler = (req, res, next) => {
  const nativeMedia = /\.(?:mp4|m4v|mov|webm|ogv|mp3|m4a|aac|wav|flac|ogg|oga|opus)$/iu.test(req.path);
  res.setHeader("Content-Security-Policy", [
    nativeMedia ? "sandbox allow-same-origin" : "sandbox",
    "default-src 'none'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
};
