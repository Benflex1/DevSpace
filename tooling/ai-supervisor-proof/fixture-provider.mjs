import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv.find((value) => value.startsWith("--mode="))?.slice(7) ?? "cooperative";
const ignoreTerm = mode === "ignore-term";
const descendant = fileURLToPath(new URL("./fixture-descendant.mjs", import.meta.url));
const escape = mode === "setsid-child";
const child = spawn(process.execPath, [
  descendant, "--spawn-grandchild", ...(ignoreTerm ? ["--ignore-term"] : []),
  ...(mode === "double-fork" ? ["--double-fork"] : [])
], { stdio: "ignore", detached: escape });
if (mode === "group-churn") {
  const timer = setInterval(() => {
    const transient = spawn(process.execPath, ["-e", "setTimeout(()=>{},25)"], { stdio: "ignore" });
    transient.unref();
  }, 5);
  timer.unref();
}
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
        process.stdout.write(`${JSON.stringify({
          type: "interrupted", requestId: value.requestId, operationId: interrupted
        })}\n`);
      } else if (value.type === "exit") {
        process.stdout.write(`${JSON.stringify({ type: "exiting" })}\n`);
        process.exit(0);
      } else if (value.type === "malformed") {
        process.stdout.write("not-json\n");
      } else {
        activeOperation = value.operationId;
        process.stdout.write(`${JSON.stringify({
          type: "echo", requestId: value.requestId, operationId: value.operationId, value: value.value
        })}\n`);
      }
    } catch { process.stderr.write("fixture-invalid-input\n"); }
  }
});
process.stdout.write(`${JSON.stringify({ type: "ready", childPid: child.pid })}\n`);
