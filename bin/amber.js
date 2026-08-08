#!/usr/bin/env node
// Enforce the engine requirement BEFORE loading anything: on old Node the
// dependency graph crashes at import time with an opaque stack trace
// (undici's File reference on Node 18) instead of a usable message.
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(
    `amber needs Node >= 24 — this is Node ${process.versions.node}.\n` +
      `  (an older Node earlier in your PATH, e.g. from nvm, is a common cause)`,
  );
  process.exit(1);
}
await import("../dist/cli.js");
