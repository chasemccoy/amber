/** Shared types for the archiver. */

/** An embed (iframe/video) whose real media should be downloaded. */
export interface MediaEmbed {
  /** CSS selector matching the embed element in the page. */
  embedSelector: string;
  /** Canonical URL yt-dlp can download (e.g. a youtube watch URL). */
  sourceUrl: string;
  /** "video" | "audio". */
  kind: "video" | "audio";
  description?: string;
}

/**
 * The judgement: what is junk and what is real media. Serialisable so it can be
 * written to disk, audited, hand-edited, and replayed with `--plan`.
 */
export interface CleanupPlan {
  title: string;
  /** CSS selector wrapping the main content, or null. */
  mainContentSelector: string | null;
  /** CSS selectors for junk to delete. */
  removeSelectors: string[];
  media: MediaEmbed[];
  notes: string;
  /** "heuristic" | "llm" | "file" | "agent". */
  source: string;
}

/** One downloaded asset and where it landed (path relative to the archive root). */
export interface Asset {
  url: string;
  localPath: string;
  contentType: string;
  ok: boolean;
  note: string;
}

/** Options shared across capture backends. */
export interface CaptureOptions {
  /**
   * "auto" (default): fetch statically, escalate to a browser render only if the
   * page looks client-rendered. "fetch" forces static; "playwright" forces a
   * full headless-Chromium render.
   */
  backend: "fetch" | "playwright" | "auto";
  timeoutMs: number;
  /** Trust a TLS-intercepting proxy (corp/CI). Off by default. */
  insecureTLS: boolean;
}
