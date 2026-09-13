import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolingDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(toolingDirectory, "..");
const outputDirectory = path.join(rootDirectory, "apps/agent/dist/native");
mkdirSync(outputDirectory, { recursive: true });
for (const helperName of ["codex-staged-readback", "codex-artifact-readback"]) {
  const sourcePath = path.join(rootDirectory, "apps/agent/native", `${helperName}.c`);
  const outputPath = path.join(outputDirectory, helperName);
  execFileSync(process.env.CC ?? "/usr/bin/cc", [
    "-std=c11", "-O2", "-pipe", "-static", "-Wl,--build-id=none", "-fno-ident", "-Wall", "-Wextra", "-Werror",
    sourcePath, "-o", outputPath
  ], { stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: "0" } });
  chmodSync(outputPath, 0o755);
}
