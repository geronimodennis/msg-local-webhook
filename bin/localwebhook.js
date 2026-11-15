#!/usr/bin/env node

import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const target = args[args.indexOf("--for") + 1];
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

if (target !== "messenger") {
  console.error("Usage: msg-local-webhook --for messenger --start");
  console.error("       msg-local-webhook --for messenger --init");
  process.exit(1);
}

if (args.includes("--init") || args.includes("init")) {
  if (existsSync(".env")) {
    console.error(".env already exists; leaving it unchanged.");
    process.exitCode = 1;
  } else {
    copyFileSync(join(packageRoot, ".env.example"), ".env");
    console.log("Created .env. Edit it before starting the watcher.");
  }
} else if (args.includes("--start")) {
  await import("../src/index.js");
} else {
  console.error("Usage: msg-local-webhook --for messenger --start");
  console.error("       msg-local-webhook --for messenger --init");
  process.exitCode = 1;
}
