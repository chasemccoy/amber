/**
 * Public library entry point. Consumers (e.g. a server importing this package)
 * should import from here rather than reaching into individual modules.
 */

export { archiveUrl, archiveFromDom, slugifyUrl } from "./pipeline.js";
export type { ArchiveOptions, ArchiveResult, DomCapture, DomArchiveOptions } from "./pipeline.js";
export type { CleanupPlan, MediaEmbed, Asset, CaptureOptions } from "./types.js";
export type { CleanReport } from "./clean.js";
