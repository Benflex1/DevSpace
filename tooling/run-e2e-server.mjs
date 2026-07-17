import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const temporaryRoot = tmpdir();
for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith("devspace-e2e-")) {
    const candidate = path.join(temporaryRoot, entry.name);
    let active = false;
    try {
      const ownerPid = Number(await readFile(path.join(candidate, "owner.pid"), "utf8"));
      if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
        process.kill(ownerPid, 0);
        active = true;
      }
    } catch { active = false; }
    if (!active) await rm(candidate, { recursive: true, force: true });
  }
}
const runtimeDirectory = await mkdtemp(path.join(temporaryRoot, "devspace-e2e-"));
await writeFile(path.join(runtimeDirectory, "owner.pid"), `${process.pid}\n`, { mode: 0o600 });
const environment = {
  ...process.env,
  DEVSPACE_AUTH_MODE: "development",
  DEVSPACE_APP_ORIGIN: "http://127.0.0.1:3100",
  DEVSPACE_DATABASE_PATH: path.join(runtimeDirectory, "devspace.sqlite"),
  DEVSPACE_AGENT_SOCKET_PATH: path.join(runtimeDirectory, "agent.sock")
};
const children = [];
const agent = spawn("pnpm", ["exec", "tsx", "apps/agent/test/e2e-server.ts"], { env: environment, stdio: "inherit" });
children.push(agent);
const web = spawn("pnpm", ["--filter", "@devspace/web", "exec", "next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3100"], {
  env: environment, stdio: "inherit"
});
children.push(web);

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  // Unlink deterministic test state immediately; Playwright may enforce a short server-stop grace period.
  await rm(runtimeDirectory, { recursive: true, force: true });
  await Promise.all(children.map((child) => child.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve))));
  process.exit(code);
}
process.once("SIGINT", () => { void stop(0); });
process.once("SIGTERM", () => { void stop(0); });
for (const child of children) child.once("exit", (code) => { if (!stopping && code !== 0) void stop(code ?? 1); });
