import assert from "node:assert/strict";
import test from "node:test";

const preflight = await import("../install-preflight.mjs").catch(() => null);

function requirePreflightFunction(name) {
  assert.equal(typeof preflight?.[name], "function", `installation preflight exports ${name}`);
  return preflight[name];
}

test("installation preflight accepts the pinned Ubuntu 24.04 amd64 runtime", () => {
  const validateSupportedHost = requirePreflightFunction("validateSupportedHost");
  assert.deepEqual(validateSupportedHost({
    platform: "linux",
    architecture: "x64",
    distribution: "ubuntu",
    version: "24.04",
    nodeVersion: "24.18.0",
    pnpmVersion: "11.13.0",
    expectedNodeVersion: "24.18.0",
    expectedPnpmVersion: "11.13.0"
  }), []);
});

test("installation preflight rejects other Linux architectures and toolchain versions", () => {
  const validateSupportedHost = requirePreflightFunction("validateSupportedHost");
  const issues = validateSupportedHost({
    platform: "linux",
    architecture: "arm64",
    distribution: "ubuntu",
    version: "24.04",
    nodeVersion: "25.0.0",
    pnpmVersion: "11.12.0",
    expectedNodeVersion: "24.18.0",
    expectedPnpmVersion: "11.13.0"
  });
  assert.ok(issues.some((issue) => issue.includes("amd64")));
  assert.ok(issues.some((issue) => issue.includes("Node.js 24.18.0")));
  assert.ok(issues.some((issue) => issue.includes("pnpm 11.13.0")));
});

test("production Web preflight rejects development auth and non-HTTPS origins", () => {
  const validateWebEnvironment = requirePreflightFunction("validateWebEnvironment");
  const issues = validateWebEnvironment({
    NODE_ENV: "production",
    DEVSPACE_AUTH_MODE: "development",
    DEVSPACE_APP_ORIGIN: "http://devspace.example.test",
    DEVSPACE_DATABASE_PATH: "/var/lib/devspace-web/devspace.sqlite",
    DEVSPACE_AGENT_SOCKET_PATH: "/run/devspace-agent/agent.sock"
  });
  assert.ok(issues.some((issue) => issue.includes("cloudflare-access")));
  assert.ok(issues.some((issue) => issue.includes("HTTPS")));
});

test("production Web preflight accepts the Cloudflare Access runtime contract", () => {
  const validateWebEnvironment = requirePreflightFunction("validateWebEnvironment");
  assert.deepEqual(validateWebEnvironment({
    NODE_ENV: "production",
    DEVSPACE_AUTH_MODE: "cloudflare-access",
    DEVSPACE_APP_ORIGIN: "https://devspace.example.test",
    DEVSPACE_ACCESS_ISSUER: "https://team.cloudflareaccess.com",
    DEVSPACE_ACCESS_AUDIENCE: "example-access-audience-tag",
    DEVSPACE_DATABASE_PATH: "/var/lib/devspace-web/devspace.sqlite",
    DEVSPACE_AGENT_SOCKET_PATH: "/run/devspace-agent/agent.sock"
  }), []);
});

test("Agent preflight requires explicit host paths for its state and rootless Docker socket", () => {
  const validateAgentEnvironment = requirePreflightFunction("validateAgentEnvironment");
  const issues = validateAgentEnvironment({
    DEVSPACE_MANAGED_ROOT: "/var/lib/devspace-agent/managed",
    DEVSPACE_AGENT_SOCKET_PATH: "/run/devspace-agent/agent.sock",
    DEVSPACE_DOCKER_SOCKET_PATH: "/var/run/docker.sock"
  });
  assert.ok(issues.some((issue) => issue.includes("rootless Docker socket")));
});

test("rootless Docker socket permits owner-only or owner-group access inside its private runtime directory", () => {
  const validateRootlessDockerSocket = requirePreflightFunction("validateRootlessDockerSocket");
  const uid = 1234;
  const gid = 1235;
  for (const mode of [0o600, 0o660]) {
    assert.deepEqual(validateRootlessDockerSocket({
      socketPath: `/run/user/${uid}/docker.sock`,
      socket: { isSocket: true, uid, gid, mode },
      runtimeDirectory: { isDirectory: true, isSymbolicLink: false, realPath: `/run/user/${uid}`, uid, mode: 0o700 },
      serviceUid: uid,
      serviceGid: gid
    }), []);
  }
});

test("rootless Docker socket rejects unauthorized modes, wrong owner/group, and a non-private runtime directory", () => {
  const validateRootlessDockerSocket = requirePreflightFunction("validateRootlessDockerSocket");
  const uid = 1234;
  const gid = 1235;
  const input = {
    socketPath: `/run/user/${uid}/docker.sock`,
    socket: { isSocket: true, uid, gid, mode: 0o660 },
    runtimeDirectory: { isDirectory: true, isSymbolicLink: false, realPath: `/run/user/${uid}`, uid, mode: 0o700 },
    serviceUid: uid,
    serviceGid: gid
  };
  assert.ok(validateRootlessDockerSocket({ ...input, socket: { ...input.socket, uid: uid + 1 } }).some((issue) => issue.includes("owned by the Agent")));
  assert.ok(validateRootlessDockerSocket({ ...input, socket: { ...input.socket, gid: gid + 1 } }).some((issue) => issue.includes("Agent primary group")));
  assert.ok(validateRootlessDockerSocket({ ...input, socket: { ...input.socket, mode: 0o666 } }).some((issue) => issue.includes("0600 or 0660")));
  assert.ok(validateRootlessDockerSocket({ ...input, runtimeDirectory: { ...input.runtimeDirectory, mode: 0o750 } }).some((issue) => issue.includes("private mode 0700")));
  assert.ok(validateRootlessDockerSocket({ ...input, runtimeDirectory: { ...input.runtimeDirectory, uid: uid + 1 } }).some((issue) => issue.includes("owned by the Agent")));
  assert.ok(validateRootlessDockerSocket({ ...input, runtimeDirectory: { ...input.runtimeDirectory, isSymbolicLink: true } }).some((issue) => issue.includes("real, private")));
});

test("rootless Docker socket rejects unexpected paths and non-socket entries", () => {
  const validateRootlessDockerSocket = requirePreflightFunction("validateRootlessDockerSocket");
  const uid = 1234;
  const gid = 1235;
  const input = {
    socketPath: `/run/user/${uid}/docker.sock`,
    socket: { isSocket: true, uid, gid, mode: 0o600 },
    runtimeDirectory: { isDirectory: true, isSymbolicLink: false, realPath: `/run/user/${uid}`, uid, mode: 0o700 },
    serviceUid: uid,
    serviceGid: gid
  };
  assert.ok(validateRootlessDockerSocket({ ...input, socketPath: "/var/run/docker.sock" }).some((issue) => issue.includes("Agent user's /run/user directory")));
  assert.ok(validateRootlessDockerSocket({ ...input, socket: { ...input.socket, isSocket: false } }).some((issue) => issue.includes("Unix socket")));
  assert.ok(validateRootlessDockerSocket({ ...input, runtimeDirectory: { ...input.runtimeDirectory, realPath: "/run/user/other" } }).some((issue) => issue.includes("real, private")));
});

test("rootless Docker detection requires the daemon's explicit rootless security option", () => {
  const isRootlessDockerInfo = requirePreflightFunction("isRootlessDockerInfo");
  assert.equal(isRootlessDockerInfo({ SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"] }), true);
  assert.equal(isRootlessDockerInfo({ SecurityOptions: ["name=seccomp,profile=builtin"] }), false);
});
