import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolingDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(toolingDirectory, "..");
const sourcePath = path.join(rootDirectory, "apps/agent/native/codex-staged-readback.c");
const outputDirectory = path.join(rootDirectory, "apps/agent/dist/native");
const outputPath = path.join(outputDirectory, "codex-staged-readback");
mkdirSync(outputDirectory, { recursive: true });
execFileSync(process.env.CC ?? "/usr/bin/cc", [
  "-std=c11", "-O2", "-pipe", "-static", "-Wl,--build-id=none", "-fno-ident", "-Wall", "-Wextra", "-Werror",
  sourcePath, "-o", outputPath
], { stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "0" } });
chmodSync(outputPath, 0o755);
