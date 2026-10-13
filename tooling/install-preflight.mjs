import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transientSocketErrors = new Set(["ENOENT", "ECONNREFUSED", "ETIMEDOUT"]);

export function validateSupportedHost(input) {
  const issues = [];
  if (input.platform !== "linux") issues.push("Ubuntu 24.04 LTS on Linux is required.");
  if (input.architecture !== "x64") issues.push("The supported host architecture is amd64 (x86_64).");
  if (input.distribution !== "ubuntu" || input.version !== "24.04") {
    issues.push("The supported operating system is Ubuntu 24.04 LTS.");
  }
  if (input.nodeVersion !== input.expectedNodeVersion) issues.push(`Node.js ${input.expectedNodeVersion} is required.`);
  if (input.pnpmVersion !== input.expectedPnpmVersion) issues.push(`pnpm ${input.expectedPnpmVersion} is required.`);
  return issues;
}

function isExactHttpsOrigin(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value;
  } catch {
    return false;
  }
}

function isAbsoluteNonEmpty(value) {
  return typeof value === "string" && value.trim() !== "" && path.isAbsolute(value.trim());
}

export function validateWebEnvironment(environment) {
  const issues = [];
  if (environment.NODE_ENV !== "production") issues.push("Web must run with NODE_ENV=production.");
  if (environment.DEVSPACE_AUTH_MODE !== "cloudflare-access") {
    issues.push("Production Web requires DEVSPACE_AUTH_MODE=cloudflare-access.");
  }
  if (!isExactHttpsOrigin(environment.DEVSPACE_APP_ORIGIN ?? "")) {
    issues.push("DEVSPACE_APP_ORIGIN must be the exact public HTTPS origin.");
  }
  if (!isExactHttpsOrigin(environment.DEVSPACE_ACCESS_ISSUER ?? "")) {
    issues.push("DEVSPACE_ACCESS_ISSUER must be the exact HTTPS Cloudflare Access team origin.");
  }
  if (typeof environment.DEVSPACE_ACCESS_AUDIENCE !== "string" || environment.DEVSPACE_ACCESS_AUDIENCE.trim() === "") {
    issues.push("DEVSPACE_ACCESS_AUDIENCE must contain the Access application's AUD tag.");
  }
  if (!isAbsoluteNonEmpty(environment.DEVSPACE_DATABASE_PATH)) {
    issues.push("DEVSPACE_DATABASE_PATH must be an absolute persistent file path.");
  }
  if (!isAbsoluteNonEmpty(environment.DEVSPACE_AGENT_SOCKET_PATH)) {
    issues.push("DEVSPACE_AGENT_SOCKET_PATH must be an absolute Agent socket path.");
  }
  return issues;
}

export function validateAgentEnvironment(environment) {
  const issues = [];
  for (const name of ["DEVSPACE_MANAGED_ROOT", "DEVSPACE_AGENT_SOCKET_PATH", "DEVSPACE_DOCKER_SOCKET_PATH"]) {
    if (!isAbsoluteNonEmpty(environment[name])) issues.push(`${name} must be an absolute host path.`);
  }
  const socketPath = environment.DEVSPACE_DOCKER_SOCKET_PATH?.trim();
  if (socketPath !== undefined && !/^\/run\/user\/[1-9][0-9]*\/docker\.sock$/u.test(socketPath)) {
    issues.push("DEVSPACE_DOCKER_SOCKET_PATH must point to the dedicated rootless Docker socket under /run/user/<uid>.");
  }
  return issues;
}

export function parseSubordinateGidRanges(contents, username, uid) {
  const owners = new Set([username, String(uid)]);
  return contents.split(/\r?\n/u).flatMap((line) => {
    const [owner, startText, countText] = line.split(":");
    if (!owners.has(owner)) return [];
    const start = Number(startText);
    const count = Number(countText);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 1
      || !Number.isSafeInteger(start + count)) return [];
    return [{ start, count }];
  });
}

export function validateRootlessDockerSocket({
  socketPath, socket, runtimeDirectory, serviceUid, serviceGid, serviceSubGidRanges = []
}) {
  const issues = [];
  const expectedSocketPath = `/run/user/${serviceUid}/docker.sock`;
  const expectedRuntimeDirectory = `/run/user/${serviceUid}`;
  if (socketPath !== expectedSocketPath) {
    issues.push("DEVSPACE_DOCKER_SOCKET_PATH must be the Agent user's /run/user directory socket.");
  }
  if (runtimeDirectory === null || !runtimeDirectory.isDirectory || runtimeDirectory.isSymbolicLink
    || runtimeDirectory.realPath !== expectedRuntimeDirectory) {
    issues.push("The Docker socket parent must be a real, private mode 0700 Agent runtime directory.");
  } else {
    if (runtimeDirectory.uid !== serviceUid) issues.push("The Docker socket parent must be owned by the Agent service user.");
    if ((runtimeDirectory.mode & 0o777) !== 0o700) {
      issues.push("The Docker socket parent must be a real, private mode 0700 Agent runtime directory.");
    }
  }
  if (socket === null || !socket.isSocket) {
    issues.push("The dedicated rootless Docker endpoint must be a Unix socket.");
  } else {
    if (socket.uid !== serviceUid) issues.push("The Docker socket must be owned by the Agent service user.");
    const mappedAgentGroup = socket.gid === serviceGid || serviceSubGidRanges.some(({ start, count }) =>
      Number.isSafeInteger(start) && Number.isSafeInteger(count) && count > 0
      && socket.gid >= start && socket.gid < start + count);
    if (!mappedAgentGroup) issues.push("The Docker socket group must be the Agent primary group or one of its mapped subordinate GIDs.");
    const mode = socket.mode & 0o777;
    if (mode !== 0o600 && mode !== 0o660) {
      issues.push("The Docker socket must use mode 0600 or 0660 with no world access.");
    }
  }
  return issues;
}

export function isRootlessDockerInfo(info) {
  return Array.isArray(info?.SecurityOptions) && info.SecurityOptions.includes("name=rootless");
}

function parseOsRelease(contents) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^([A-Z_]+)=(?:"([^"]*)"|'([^']*)'|([^#]*))$/u.exec(line);
    if (match === null) continue;
    values.set(match[1], (match[2] ?? match[3] ?? match[4] ?? "").trim());
  }
  return values;
}

async function readHostVersions() {
  const [release, packageJson] = await Promise.all([
    readFile("/etc/os-release", "utf8"),
    readFile(path.join(rootDirectory, "package.json"), "utf8")
  ]);
  const parsedRelease = parseOsRelease(release);
  const manifest = JSON.parse(packageJson);
  const packageManager = /^pnpm@(.+)$/u.exec(manifest.packageManager ?? "");
  if (packageManager?.[1] === undefined) throw new Error("package.json must pin pnpm in packageManager.");
  return {
    platform: process.platform,
    architecture: process.arch,
    distribution: parsedRelease.get("ID") ?? "unknown",
    version: parsedRelease.get("VERSION_ID") ?? "unknown",
    nodeVersion: process.versions.node,
    expectedNodeVersion: (await readFile(path.join(rootDirectory, ".nvmrc"), "utf8")).trim().replace(/^v/u, ""),
    expectedPnpmVersion: packageManager[1]
  };
}

async function installedPnpmVersion() {
  try {
    const result = await execFileAsync("pnpm", ["--version"], { timeout: 5_000 });
    return result.stdout.trim();
  } catch {
    return "unavailable";
  }
}

async function assertPrivateDirectory(directory, label) {
  if (!path.isAbsolute(directory)) throw new Error(`${label} must be an absolute path.`);
  const entry = await lstat(directory).catch(() => null);
  if (entry === null || !entry.isDirectory() || entry.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error(`${label} must be a provisioned real directory.`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && entry.uid !== uid) throw new Error(`${label} must be owned by the service user.`);
  if ((entry.mode & 0o077) !== 0) throw new Error(`${label} must not grant group or other access.`);
  try {
    await access(directory, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    throw new Error(`${label} must be readable and writable by the service user.`);
  }
}

async function assertPrivateDatabaseFile(databasePath) {
  let entry;
  try { entry = await lstat(databasePath); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("The Web database file could not be inspected.", { cause: error });
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("DEVSPACE_DATABASE_PATH must be a regular file, not a symlink.");
  const uid = process.getuid?.();
  if (uid !== undefined && entry.uid !== uid) throw new Error("The Web database file must be owned by the Web service user.");
  if ((entry.mode & 0o077) !== 0) throw new Error("The Web database file must not grant group or other access.");
}

function connectUnixSocket(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      const error = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      socket.destroy(error);
    }, timeoutMs);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function waitForUnixSocketConnectable(socketPath, label, { timeoutMs = 30_000, retryMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    try {
      await connectUnixSocket(socketPath, Math.min(3_000, remainingMs));
      return;
    } catch (error) {
      lastError = error;
      if (!transientSocketErrors.has(error?.code)) {
        throw new Error(`${label} is not reachable by this service user.`, { cause: error });
      }
    }
    const remainingMsAfterAttempt = deadline - Date.now();
    if (remainingMsAfterAttempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs, remainingMsAfterAttempt)));
    }
  }
  throw new Error(`${label} did not become reachable within ${timeoutMs} ms.`, { cause: lastError });
}

async function readDockerInfo(socketPath) {
  return await new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: "/info", timeout: 5_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 512 * 1024) request.destroy(new Error("response-too-large"));
      });
      response.once("end", () => {
        if (response.statusCode !== 200) return reject(new Error("Docker Engine /info did not return HTTP 200."));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("Docker Engine /info did not return JSON.")); }
      });
    });
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", () => reject(new Error("The configured Docker socket is not responding.")));
  });
}

async function validateHost() {
  const versions = await readHostVersions();
  const pnpmVersion = await installedPnpmVersion();
  const issues = validateSupportedHost({ ...versions, pnpmVersion });
  if (issues.length > 0) throw new Error(issues.join("\n"));
}

async function validateAgentRuntime(environment) {
  for (const issue of validateAgentEnvironment(environment)) throw new Error(issue);
  const managedRoot = environment.DEVSPACE_MANAGED_ROOT.trim();
  for (const relative of ["projects", "workspaces", "state", "state/operations"]) {
    await assertPrivateDirectory(path.join(managedRoot, relative), `Agent ${relative} directory`);
  }
  const socketPath = environment.DEVSPACE_DOCKER_SOCKET_PATH.trim();
  if (socketPath !== `/run/user/${process.getuid?.() ?? ""}/docker.sock`) {
    throw new Error("The Agent must use the rootless Docker socket owned by its own service account.");
  }
  const runtimeDirectoryPath = path.dirname(socketPath);
  const serviceUid = process.getuid?.() ?? -1;
  const serviceGid = process.getgid?.() ?? -1;
  const passwdEntry = await execFileAsync("getent", ["passwd", String(serviceUid)], { timeout: 5_000 }).catch(() => ({ stdout: "" }));
  const username = passwdEntry.stdout.trim().split(":")[0] ?? "";
  const subGidContents = await readFile("/etc/subgid", "utf8").catch(() => "");
  const [socket, runtimeDirectoryEntry, runtimeDirectoryRealPath] = await Promise.all([
    lstat(socketPath).catch(() => null),
    lstat(runtimeDirectoryPath).catch(() => null),
    realpath(runtimeDirectoryPath).catch(() => "")
  ]);
  const issues = validateRootlessDockerSocket({
    socketPath,
    socket: socket === null ? null : { isSocket: socket.isSocket(), uid: socket.uid, gid: socket.gid, mode: socket.mode },
    runtimeDirectory: runtimeDirectoryEntry === null ? null : {
      isDirectory: runtimeDirectoryEntry.isDirectory(), isSymbolicLink: runtimeDirectoryEntry.isSymbolicLink(),
      realPath: runtimeDirectoryRealPath, uid: runtimeDirectoryEntry.uid, mode: runtimeDirectoryEntry.mode
    },
    serviceUid,
    serviceGid,
    serviceSubGidRanges: parseSubordinateGidRanges(subGidContents, username, serviceUid)
  });
  if (issues.length > 0) throw new Error(issues[0]);
  const dockerInfo = await readDockerInfo(socketPath);
  if (!isRootlessDockerInfo(dockerInfo)) throw new Error("The configured Docker daemon does not report rootless mode.");
}

async function validateWebRuntime(environment) {
  for (const issue of validateWebEnvironment(environment)) throw new Error(issue);
  const databasePath = environment.DEVSPACE_DATABASE_PATH.trim();
  await assertPrivateDirectory(path.dirname(databasePath), "Web state directory");
  await assertPrivateDatabaseFile(databasePath);
  await waitForUnixSocketConnectable(environment.DEVSPACE_AGENT_SOCKET_PATH.trim(), "Agent socket");
}

async function main(role) {
  if (role !== "agent" && role !== "web") {
    console.error("Usage: node tooling/install-preflight.mjs <agent|web>");
    process.exitCode = 2;
    return;
  }
  try {
    await validateHost();
    console.log("PASS: Ubuntu 24.04 amd64 and pinned Node.js/pnpm versions");
    if (role === "agent") {
      await validateAgentRuntime(process.env);
      console.log("PASS: private Agent state paths and dedicated rootless Docker socket");
    } else {
      await validateWebRuntime(process.env);
      console.log("PASS: production Cloudflare Access configuration and private Web state");
      console.log("PASS: Web service can connect to the Agent socket");
    }
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : "installation preflight failed"}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv[2]);
}
