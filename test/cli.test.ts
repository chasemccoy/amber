/**
 * CLI surface tests — spawn the real CLI and assert on stdout/stderr/exit code.
 * This is where user-facing regressions live (--help crashed with a stack
 * trace for three releases), so the assertions pin the *experience*: right
 * exit codes, usage on bad input, and never a stack trace for expected errors.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileP = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const PKG = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], envPatch: Record<string, string | undefined> = {}): Promise<RunResult> {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(envPatch)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    const { stdout, stderr } = await execFileP(process.execPath, ["--import", "tsx", CLI, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("--help prints usage and all flags, exit 0", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: amber \[options\] <url>/);
  for (const flag of ["--static", "--playwright", "--no-llm", "--plan", "--overwrite", "--version"]) {
    assert.ok(r.stdout.includes(flag), `help should mention ${flag}`);
  }
  assert.match(r.stdout, /agent <url>/);
  assert.match(r.stdout, /doctor/);
});

test("--version prints the package.json version, exit 0", async () => {
  const r = await runCli(["--version"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), PKG.version);
});

test("unknown flag: usage + message, exit 2, and no stack trace", async () => {
  const r = await runCli(["--nope"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown option '--nope'/);
  assert.match(r.stderr, /usage: amber/);
  assert.doesNotMatch(r.stderr, /at [\w.]+ \(/, "expected no stack trace for a bad flag");
});

test("no url: usage, exit 2", async () => {
  const r = await runCli([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: amber/);
});

test("--static and --playwright are mutually exclusive, exit 2", async () => {
  const r = await runCli(["--static", "--playwright", "https://example.com"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /mutually exclusive/);
});

test("agent --help prints agent help, exit 0", async () => {
  const r = await runCli(["agent", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: amber agent \[options\] <url>/);
  assert.match(r.stdout, /ANTHROPIC_API_KEY/);
});

test("agent with no url: usage, exit 2", async () => {
  const r = await runCli(["agent"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: amber agent/);
});

test("agent without a key: plain actionable error, exit 1, no stack trace", async () => {
  const r = await runCli(["agent", "https://example.com"], { ANTHROPIC_API_KEY: undefined });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ANTHROPIC_API_KEY/);
  assert.match(r.stderr, /--no-llm/, "should point at the free alternative");
  assert.doesNotMatch(r.stderr, /at [\w.]+ \(/, "expected no stack trace for a missing key");
});

test("doctor runs and reports, exit 0", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amber-doctor-"));
  const r = await runCli(["doctor"], { AMBER_ARCHIVE_DIR: tmp });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /amber doctor/);
  assert.match(r.stdout, /Node /);
  assert.match(r.stdout, /archive directory writable/);
});
