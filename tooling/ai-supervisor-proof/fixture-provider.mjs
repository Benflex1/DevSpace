import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ignoreTerm = process.argv.includes("--ignore-term");
const descendant = fileURLToPath(new URL("./fixture-descendant.mjs", import.meta.url));
const child = spawn(process.execPath, [descendant, "--spawn-grandchild", ...(ignoreTerm ? ["--ignore-term"] : [])],
  { stdio: "ignore" });
if (ignoreTerm) process.on("SIGTERM", () => {});

let activeOperation = null;
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  while (buffered.includes("\n")) {
    const index = buffered.indexOf("\n");
    const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
    try {
      const value = JSON.parse(line);
      if (value.type === "interrupt") {
        const interrupted = activeOperation; activeOperation = null;
        process.stdout.write(`${JSON.stringify({ type: "interrupted", operationId: interrupted })}\n`);
      } else if (value.type === "exit") {
        process.stdout.write(`${JSON.stringify({ type: "exiting" })}\n`);
        process.exit(0);
      } else if (value.type === "malformed") {
        process.stdout.write("not-json\n");
      } else {
        activeOperation = value.operationId;
        process.stdout.write(`${JSON.stringify({ type: "echo", operationId: value.operationId, value: value.value })}\n`);
      }
    } catch { process.stderr.write("fixture-invalid-input\n"); }
  }
});
process.stdout.write(`${JSON.stringify({ type: "ready", childPid: child.pid })}\n`);
