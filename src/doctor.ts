/**
 * `amber doctor` — check the environment and report what works, what's missing,
 * and what each missing piece costs. Nothing here is fatal except an unwritable
 * archive directory: amber degrades gracefully (heuristics without a key,
 * static capture without Playwright, skipped media without yt-dlp), and this
 * command is where that degradation is made visible up front.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { defaultArchiveDir } from "./pipeline.js";

type Status = "ok" | "warn" | "fail";

interface Check {
  status: Status;
  summary: string;
  /** Remedy or consequence, printed indented under the summary. */
  detail?: string;
}

/** First line of `<cmd> --version`, or null if the binary isn't on PATH. */
function commandVersion(cmd: string): string | null {
  const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr).trim().split("\n")[0] || "installed";
}

function checkNode(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 20
    ? { status: "ok", summary: `Node ${process.versions.node}` }
    : { status: "fail", summary: `Node ${process.versions.node} — amber needs Node ≥ 20` };
}

function checkApiKey(): Check {
  return process.env.ANTHROPIC_API_KEY
    ? { status: "ok", summary: "ANTHROPIC_API_KEY set — Claude judges the cleanup" }
    : {
        status: "warn",
        summary: "ANTHROPIC_API_KEY not set — cleanup uses heuristics only",
        detail: "Set a key to have Claude decide what's junk: https://console.anthropic.com/",
      };
}

async function checkPlaywright(): Promise<Check> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return {
      status: "warn",
      summary: "Playwright not installed — JS-heavy pages fall back to static capture",
      detail: "npm install -g playwright && playwright install chromium",
    };
  }
  try {
    const exe = chromium.executablePath();
    if (exe && fs.existsSync(exe)) {
      return { status: "ok", summary: "Playwright + Chromium — headless render available" };
    }
  } catch {
    /* fall through to the not-downloaded case */
  }
  return {
    status: "warn",
    summary: "Playwright installed, but Chromium isn't downloaded",
    detail: "playwright install chromium",
  };
}

function checkYtDlp(): Check {
  const v = commandVersion("yt-dlp");
  return v
    ? { status: "ok", summary: `yt-dlp ${v} — embedded media downloads work` }
    : {
        status: "warn",
        summary: "yt-dlp not on PATH — video/audio embeds are left in place, not downloaded",
        detail: "brew install yt-dlp   (or: pipx install yt-dlp)",
      };
}

function checkFfmpeg(): Check {
  return commandVersion("ffmpeg")
    ? { status: "ok", summary: "ffmpeg — separate video+audio streams can be muxed" }
    : {
        status: "warn",
        summary: "ffmpeg not on PATH — some downloads limited to single-file formats",
        detail: "brew install ffmpeg   (or set AMBER_MEDIA_FORMAT to a progressive format)",
      };
}

function checkArchiveDir(): Check {
  const dir = defaultArchiveDir();
  const pretty = dir.startsWith(os.homedir()) ? dir.replace(os.homedir(), "~") : dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { status: "ok", summary: `archive directory writable: ${pretty}` };
  } catch (err) {
    return {
      status: "fail",
      summary: `archive directory not writable: ${pretty} (${(err as Error).message})`,
      detail: "Choose another with -o <dir> or AMBER_ARCHIVE_DIR",
    };
  }
}

const GLYPH: Record<Status, string> = { ok: "✓", warn: "○", fail: "✗" };

/** Run every check, print the report, and return a process exit code. */
export async function runDoctor(): Promise<number> {
  const checks = [
    checkNode(),
    checkApiKey(),
    await checkPlaywright(),
    checkYtDlp(),
    checkFfmpeg(),
    checkArchiveDir(),
  ];

  console.log("amber doctor\n");
  for (const c of checks) {
    console.log(`  ${GLYPH[c.status]} ${c.summary}`);
    if (c.detail && c.status !== "ok") console.log(`      ${c.detail}`);
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  console.log(
    fails
      ? `\n${fails} problem(s) need fixing before amber can archive.`
      : warns
        ? `\nReady to archive — ${warns} optional piece(s) missing (see above for what they add).`
        : "\nEverything's in place.",
  );
  return fails ? 1 : 0;
}
