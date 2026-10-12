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

test("rootless Docker detection requires the daemon's explicit rootless security option", () => {
  const isRootlessDockerInfo = requirePreflightFunction("isRootlessDockerInfo");
  assert.equal(isRootlessDockerInfo({ SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"] }), true);
  assert.equal(isRootlessDockerInfo({ SecurityOptions: ["name=seccomp,profile=builtin"] }), false);
});
