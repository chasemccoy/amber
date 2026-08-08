/**
 * Playwright capture backend: render a page in headless Chromium so JavaScript,
 * lazy-loaded images, and client-rendered content are all present before we
 * capture. While the browser loads the page it already fetches every asset, so
 * we snapshot those response bodies and hand them to the capturer — no second
 * download, and we get assets that a plain HTTP fetch couldn't (JS-injected,
 * cookie-gated, etc.).
 */

import { AmberError } from "./errors.js";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface RenderedResource {
  contentType: string;
  body: Buffer;
  /**
   * Playwright's request.resourceType() — "script", "xhr", "fetch",
   * "stylesheet", … Lets keep-js mode tell app code and runtime data apart.
   * Absent for resources that arrived without one (extension captures).
   */
  resourceType?: string;
}

export interface RenderResult {
  html: string;
  finalUrl: string;
  baseUrl: string;
  /** url (without fragment) -> bytes the browser already downloaded. */
  resources: Map<string, RenderedResource>;
}

export interface RenderOptions {
  timeoutMs: number;
  insecureTLS: boolean;
  /**
   * keep-js: seed Math.random with a fixed PRNG before any page script runs.
   * The replay shim seeds identically, so a page that randomises at boot
   * (pick-a-film, A/B variants) makes the same choices offline as it did
   * during the recorded render — otherwise it would request variants the
   * recording never captured.
   */
  deterministicRandom?: boolean;
}

/** Mulberry32 over a fixed seed — tiny, and identical in render + shim. */
export const SEEDED_RANDOM_SNIPPET = `(function () {
  var s = 0xA3C59AC3;
  Math.random = function () {
    s = (s + 0x6D2B79F5) | 0;
    var t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;

/**
 * Scroll the page to trigger lazy-loaded images/content, then return to top.
 * keep-js uses a denser sweep (smaller steps): scroll-scrubbed sites request
 * assets per scroll band, and each band the sweep skips is an asset the
 * offline replay won't have.
 */
async function autoScroll(page: import("playwright").Page, dense = false): Promise<void> {
  await page.evaluate(async ({ step, interval }: { step: number; interval: number }) => {
    // This callback runs in the browser. Reach the window/document globals via
    // globalThis so the file doesn't require the DOM lib when type-checked by a
    // consumer that imports amber (e.g. a Node server without "DOM" in its lib).
    const w = globalThis as unknown as {
      innerHeight: number;
      scrollBy: (x: number, y: number) => void;
      scrollTo: (x: number, y: number) => void;
      document: { body: { scrollHeight: number } };
    };
    await new Promise<void>((resolve) => {
      let total = 0;
      const timer = setInterval(() => {
        w.scrollBy(0, step);
        total += step;
        if (total >= w.document.body.scrollHeight + w.innerHeight) {
          clearInterval(timer);
          w.scrollTo(0, 0);
          resolve();
        }
      }, interval);
    });
  }, dense ? { step: 250, interval: 60 } : { step: 600, interval: 80 });
}

/**
 * Load Playwright, which is an optional peer dependency: static-only installs
 * skip its ~300 MB of browser + driver entirely. Missing module → an error that
 * says how to opt in.
 */
async function loadChromium(): Promise<typeof import("playwright").chromium> {
  try {
    return (await import("playwright")).chromium;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw err;
    throw new AmberError(
      "this page needs a headless-browser render, but Playwright isn't installed.\n" +
        "  Install it:  npm install -g playwright && playwright install chromium\n" +
        "  Or force a browserless capture with --static",
    );
  }
}

export async function renderPage(url: string, opts: RenderOptions): Promise<RenderResult> {
  // Imported lazily so consumers that never render (e.g. a server doing only
  // static fetches) don't load Playwright at startup.
  const chromium = await loadChromium();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      ignoreHTTPSErrors: opts.insecureTLS,
    });
    const page = await context.newPage();
    if (opts.deterministicRandom) await page.addInitScript(SEEDED_RANDOM_SNIPPET);

    const resources = new Map<string, RenderedResource>();
    const pending: Promise<void>[] = [];
    page.on("response", (resp) => {
      pending.push(
        (async () => {
          try {
            const req = resp.request();
            if (req.resourceType() === "document") return; // the page HTML, not an asset
            const ct = resp.headers()["content-type"] ?? "";
            const body = await resp.body();
            resources.set(resp.url().split("#")[0]!, {
              contentType: ct,
              body,
              resourceType: req.resourceType(),
            });
          } catch {
            /* streaming/redirect/opaque responses have no body — skip */
          }
        })(),
      );
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeoutMs });
    await autoScroll(page, opts.deterministicRandom).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await Promise.allSettled(pending);

    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl, baseUrl: finalUrl, resources };
  } finally {
    await browser.close();
  }
}
