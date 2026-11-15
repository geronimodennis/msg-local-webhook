#!/usr/bin/env node

import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.argv[2] === "init") {
  if (existsSync(".env")) {
    console.error(".env already exists; leaving it unchanged.");
    process.exitCode = 1;
  } else {
    copyFileSync(join(packageRoot, ".env.example"), ".env");
    console.log("Created .env. Edit it before starting the watcher.");
  }
} else {
  await import("../src/index.js");
}
