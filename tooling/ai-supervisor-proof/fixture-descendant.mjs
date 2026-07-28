import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ignoreTerm = process.argv.includes("--ignore-term");
if (process.argv.includes("--spawn-grandchild")) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), ...(ignoreTerm ? ["--ignore-term"] : [])],
    { stdio: "ignore", detached: process.argv.includes("--double-fork") });
}
if (ignoreTerm) process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
