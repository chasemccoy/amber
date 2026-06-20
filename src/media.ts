/**
 * Download embedded media by shelling out to yt-dlp.
 *
 * When a page embeds a video or audio player (e.g. a YouTube talk), we want the
 * real media file, not the embed code. yt-dlp resolves and downloads it into
 * `assets/media/`; we hand back the local path so the embed can be swapped for a
 * local <video>/<audio>.
 *
 * yt-dlp is invoked as a binary (the canonical way to use it). Install it on the
 * machine you run this on: `pipx install yt-dlp` or `brew install yt-dlp`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

export interface MediaResult {
  sourceUrl: string;
  localPath: string | null;
  ok: boolean;
  note: string;
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: -1, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

export async function downloadMedia(
  sourceUrl: string,
  rootDir: string,
  kind: "video" | "audio" = "video",
): Promise<MediaResult> {
  const mediaDir = path.join(rootDir, "assets", "media");
  fs.mkdirSync(mediaDir, { recursive: true });

  const format =
    process.env.AMBER_MEDIA_FORMAT ??
    (kind === "audio"
      ? "bestaudio/best"
      : "bestvideo[height<=1080]+bestaudio/best/best");

  const before = new Set(fs.readdirSync(mediaDir));
  const args = [
    sourceUrl,
    "-o",
    path.join(mediaDir, "%(id)s.%(ext)s"),
    "-f",
    format,
    "--no-playlist",
    "--no-progress",
    "--quiet",
    "--no-warnings",
  ];
  if (kind === "video") args.push("--merge-output-format", "mp4");
  // Opt-in for networks behind a trusted TLS-intercepting proxy (corp/CI). Off
  // by default — keep verification on when running on your own machine.
  if (process.env.AMBER_INSECURE_TLS === "1") args.push("--no-check-certificates");

  const { code, stderr } = await run("yt-dlp", args);
  if (code !== 0) {
    const note = code === -1 ? "yt-dlp not found on PATH (install it)" : stderr.trim().split("\n").pop() ?? "failed";
    return { sourceUrl, localPath: null, ok: false, note };
  }

  const after = fs.readdirSync(mediaDir).filter((f) => !before.has(f));
  if (after.length === 0) {
    return { sourceUrl, localPath: null, ok: false, note: "download produced no file" };
  }
  // newest new file wins (handles merged outputs)
  after.sort(
    (a, b) =>
      fs.statSync(path.join(mediaDir, b)).mtimeMs - fs.statSync(path.join(mediaDir, a)).mtimeMs,
  );
  const rel = path.join("assets", "media", after[0]!).split(path.sep).join("/");
  return { sourceUrl, localPath: rel, ok: true, note: after[0]! };
}
