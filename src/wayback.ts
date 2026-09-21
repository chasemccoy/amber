/**
 * Wayback Machine capture backend: archive a historical version of a page "as
 * if" it had been captured then.
 *
 * The key trick is Wayback's `id_` modifier — `web.archive.org/web/<ts>id_/<url>`
 * returns the ORIGINAL bytes of that capture, untouched (no toolbar, no
 * `wombat.js`, no rewritten URLs). So a Wayback capture is just amber's static
 * path with every request routed through the archive at a timestamp: the page
 * via `id_`, and every asset via `id_` too (Wayback redirects each to its
 * nearest capture). The slug, `sourceUrl`, and every asset name stay keyed by
 * the ORIGINAL URLs; the manifest records the snapshot as provenance and
 * `snapshotAt` becomes the archive's effective date (see snapshot.ts).
 */

import { fetchRetrying } from "./capture.js";
import { decodeHtml } from "./charset.js";
import { AmberError } from "./errors.js";
import type { FulfilledResponse } from "./render.js";

export const WAYBACK_BASE = "https://web.archive.org";

/** Identify ourselves to archive.org rather than impersonating a browser. */
export const WAYBACK_USER_AGENT = "amber (+https://github.com/chasemccoy/amber)";

/**
 * Etiquette for archive.org, from observation: it doesn't answer bursts with
 * 429 — it refuses TCP connections after ~10 rapid requests. Space requests
 * out and retry connection failures with real backoff.
 */
export const WAYBACK_REQUEST_DELAY_MS = 500;
export const WAYBACK_RETRY = { attempts: 5, baseDelayMs: 2000 } as const;

export interface WaybackRef {
  /** Timestamp as given — 4 to 14 digits (YYYY … YYYYMMDDhhmmss). */
  timestamp: string;
  /** The archived page's own URL. */
  originalUrl: string;
}

/**
 * Recognise a Wayback URL and pull out the timestamp + original URL.
 * Accepts any replay modifier (`id_`, `im_`, `if_`, …) and both http/https.
 * `base` lets tests point at a fake archive host; the real one always matches.
 */
export function parseWaybackUrl(url: string, base?: string): WaybackRef | null {
  const s = url.trim();
  let rest: string | null = null;
  for (const origin of ["https://web.archive.org", "http://web.archive.org", ...(base ? [base.replace(/\/+$/, "")] : [])]) {
    if (s.toLowerCase().startsWith(origin.toLowerCase() + "/web/")) {
      rest = s.slice(origin.length + "/web/".length);
      break;
    }
  }
  if (rest === null) return null;
  const m = /^(\d{4,14})(?:[a-z]{2}_)?\/(.+)$/i.exec(rest);
  if (!m) return null;
  let original = m[2]!;
  // Wayback tolerates a scheme-less original ("/web/2009/example.com/") and
  // occasionally collapses "http://" to "http:/" — normalise to a real URL.
  original = original.replace(/^(https?:)\/(?!\/)/i, "$1//");
  if (!/^https?:\/\//i.test(original)) original = `http://${original}`;
  try {
    new URL(original);
  } catch {
    return null;
  }
  return { timestamp: m[1]!, originalUrl: original };
}

/**
 * Normalise a user-supplied date into Wayback's digit timestamp: "2009",
 * "2009-06", "2009-06-15", "2009-06-15T14:30", or a raw 4–14-digit stamp. The
 * result may be partial — Wayback snaps it to the nearest capture.
 */
export function normalizeTimestamp(input: string): string {
  const s = input.trim();
  if (/^\d{4,14}$/.test(s)) return s;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2}))?)?)?)?)?$/.exec(s);
  if (!m) {
    throw new AmberError(
      `can't read "${input}" as a date — use YYYY, YYYY-MM, YYYY-MM-DD, or a Wayback timestamp like 20090615123456`,
    );
  }
  return m.slice(1).filter((p): p is string => p !== undefined).join("");
}

/**
 * A Wayback timestamp (UTC digits) as ISO-8601. Partial stamps ("2009",
 * "200906") resolve to their first instant — only the served capture's full
 * 14-digit stamp should normally reach here.
 */
export function timestampToIso(ts: string): string {
  const p = ts.padEnd(14, "0");
  const y = p.slice(0, 4);
  const month = p.slice(4, 6) === "00" ? "01" : p.slice(4, 6);
  const day = p.slice(6, 8) === "00" ? "01" : p.slice(6, 8);
  return `${y}-${month}-${day}T${p.slice(8, 10)}:${p.slice(10, 12)}:${p.slice(12, 14)}.000Z`;
}

/** "20090615083000" → "2009-06-15 08:30 UTC" (partial stamps render what they have). */
export function formatTimestamp(ts: string): string {
  const y = ts.slice(0, 4), mo = ts.slice(4, 6), d = ts.slice(6, 8), h = ts.slice(8, 10), mi = ts.slice(10, 12);
  let out = y;
  if (mo) out += `-${mo}`;
  if (d) out += `-${d}`;
  if (h) out += ` ${h}:${mi || "00"} UTC`;
  return out;
}

/** The `id_` (raw-bytes) replay URL for `originalUrl` at `timestamp`. */
export function waybackFetchUrl(timestamp: string, originalUrl: string, base = WAYBACK_BASE): string {
  return `${base}/web/${timestamp}id_/${originalUrl}`;
}

/** A Capturer `resolveUrl` hook: fetch every asset through Wayback at `timestamp`. */
export function waybackResolver(timestamp: string, base = WAYBACK_BASE): (absUrl: string) => string {
  return (absUrl) => waybackFetchUrl(timestamp, absUrl, base);
}

/** The human-facing replay URL (with toolbar) for the manifest. */
export function waybackViewUrl(timestamp: string, originalUrl: string, base = WAYBACK_BASE): string {
  return `${base}/web/${timestamp}/${originalUrl}`;
}

export interface WaybackPage {
  html: string;
  /** The undecoded bytes, for serving to a browser render as-is. */
  body: Buffer;
  contentType: string;
  /** The capture Wayback actually served (nearest to the request), 14 digits. */
  timestamp: string;
  /** The original URL of the served capture — differs from the request when the site itself redirected. */
  originalUrl: string;
  /** ISO form of `timestamp`, for `snapshotAt`. */
  snapshotAt: string;
}

/**
 * "This URL as it is right now on Wayback": the current moment as a stamp.
 * Wayback resolves a request to the NEAREST capture in either direction, so
 * nearest-to-now is the most recent capture — no discovery API needed (the
 * Availability API misses bare-host lookups and CDX takes up to a minute).
 */
export function nowTimestamp(now = new Date()): string {
  return now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * Fetch the raw bytes of `ref` from Wayback, following its redirect to the
 * nearest capture, and report which capture was actually served. Wayback
 * resolves partial stamps and bare hosts itself (adding `www.` where that's
 * what it archived) — the redirect IS the lookup.
 */
export async function fetchWaybackPage(
  ref: WaybackRef,
  opts: { base?: string; retry?: { attempts: number; baseDelayMs: number } } = {},
): Promise<WaybackPage> {
  const base = opts.base ?? WAYBACK_BASE;
  const url = waybackFetchUrl(ref.timestamp, ref.originalUrl, base);
  const res = await fetchRetrying(url, { headers: { "User-Agent": WAYBACK_USER_AGENT }, redirect: "follow" }, opts.retry ?? WAYBACK_RETRY);

  // Memento-Datetime is present on every replayed capture — including a
  // captured error page — and absent from Wayback's own "not archived" page.
  const memento = res.headers.get("memento-datetime");
  // Wayback only ever redirects within itself (to the nearest capture). A
  // final URL off the archive is not a capture — never archive that page, and
  // never date it by the stamp that was asked for.
  const served = parseWaybackUrl(res.url, base);
  if (!served && !memento) {
    throw new AmberError(`the Wayback Machine redirected ${url} off the archive to ${res.url}`);
  }
  if (!res.ok) {
    if (res.status === 404 && !memento) {
      throw new AmberError(`the Wayback Machine has no capture of ${ref.originalUrl} (${formatTimestamp(ref.timestamp)})`);
    }
    throw new AmberError(
      memento
        ? `${ref.originalUrl} answered HTTP ${res.status} when it was captured (${memento}) — that's the archived page`
        : `the Wayback Machine returned HTTP ${res.status} for ${url}`,
    );
  }

  // Which capture did we get? The final URL embeds the actual timestamp and
  // the (canonicalised) original URL; Memento-Datetime is the authoritative time.
  const got = served ?? ref;
  const timestamp = (memento && mementoToTimestamp(memento)) || got.timestamp;
  const body = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "";
  return {
    html: decodeHtml(body, contentType),
    body,
    contentType,
    timestamp,
    originalUrl: canonicalOriginalUrl(got.originalUrl),
    snapshotAt: timestampToIso(timestamp),
  };
}

/**
 * A request fulfiller for a Playwright render (RenderOptions.fulfill): every
 * URL the page asks for is fetched from Wayback's raw `id_` endpoint at
 * `timestamp` and handed to the browser, so the page runs against its own
 * era's assets while believing it's on its original origin. Fetches are
 * serialised and spaced (archive.org refuses bursts), results cached per URL,
 * and `seed` pre-answers URLs already fetched (the page itself).
 */
export function waybackFulfiller(
  timestamp: string,
  opts: {
    base?: string;
    delayMs?: number;
    retry?: { attempts: number; baseDelayMs: number };
    seed?: Map<string, FulfilledResponse>;
    /** Called for each served URL — the pipeline logs progress from it. */
    onFetch?: (url: string, status: number) => void;
  } = {},
): (url: string, resourceType: string) => Promise<FulfilledResponse | null> {
  const base = opts.base ?? WAYBACK_BASE;
  const delay = opts.delayMs ?? WAYBACK_REQUEST_DELAY_MS;
  const cache = new Map<string, Promise<FulfilledResponse | null>>();
  for (const [url, r] of opts.seed ?? []) cache.set(url.split("#")[0]!, Promise.resolve(r));
  let chain: Promise<unknown> = Promise.resolve();

  return (rawUrl) => {
    const url = rawUrl.split("#")[0]!;
    if (!/^https?:/i.test(url)) return Promise.resolve(null);
    const hit = cache.get(url);
    if (hit) return hit;
    const p = (chain = chain.then(async () => {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        const res = await fetchRetrying(
          waybackFetchUrl(timestamp, url, base),
          { headers: { "User-Agent": WAYBACK_USER_AGENT }, redirect: "follow" },
          opts.retry ?? WAYBACK_RETRY,
        );
        const body = Buffer.from(await res.arrayBuffer());
        opts.onFetch?.(url, res.status);
        return { status: res.status, contentType: res.headers.get("content-type") ?? "", body };
      } catch {
        opts.onFetch?.(url, 0);
        return null;
      }
    })) as Promise<FulfilledResponse | null>;
    cache.set(url, p);
    return p;
  };
}

/**
 * Wayback's redirect canonicalises the original URL in ways nobody wants to
 * keep: it doubles a trailing slash ("http://example.com//") and spells out
 * default ports. Collapse repeated slashes and let URL drop the port.
 */
export function canonicalOriginalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/{2,}/g, "/");
    return u.toString();
  } catch {
    return url;
  }
}

/** "Mon, 15 Jun 2009 08:30:00 GMT" → "20090615083000". */
export function mementoToTimestamp(header: string): string | null {
  const t = new Date(header).getTime();
  if (Number.isNaN(t)) return null;
  return nowTimestamp(new Date(t));
}
