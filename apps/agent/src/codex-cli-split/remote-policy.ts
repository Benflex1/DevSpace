import { open } from "node:fs/promises";
import path from "node:path";
import { assertContained, establishPinnedDirectory, lstatIdentity, readRegularFileNoFollow } from "../private-state.js";
import type { CodexNativeHomeBinding } from "./native-home.js";
import type { CodexSplitTransportBinding } from "./transport.js";

const ADMITTED_CODEX_VERSION = "0.153.4" as const;
const CODEX_HOME_TARGET = "/codex-home" as const;
const LOGICAL_CWD = "/workspace" as const;
const REMOTE_ENVIRONMENT_ID = "remote" as const;
const REQUIREMENTS_TARGET = "/etc/codex/requirements.toml" as const;
const POLICY_FILE_MODE = 0o600;
const MAX_POLICY_BYTES = 16 * 1024;

const FORBIDDEN_LOCAL_PATHS = [
  "local-environment",
  "shell",
  "unified-exec-disabled",
  "missing-endpoint",
  "stale-endpoint",
  "command-hooks",
  "legacy-notify",
  "local-mcp-stdio",
  "local-http-helper",
  "unsafe-plugin-maintenance",
  "program-executor",
  "shared-app-server-daemon",
  "danger-full-access",
  "sandbox-bypass",
  "remote-local-fallback"
] as const satisfies readonly CodexForbiddenLocalPath[];

const MANAGED_REQUIREMENTS_TOML = `# Agent-owned Codex split control policy for admitted Codex ${ADMITTED_CODEX_VERSION}.
# This is a restrictive requirements layer; it is not a filesystem deny rule.
allowed_approval_policies = ["on-request"]
allowed_approvals_reviewers = ["user"]
allowed_sandbox_modes = ["read-only", "workspace-write"]
allow_login_shell = false
allow_managed_hooks_only = true

[features]
unified_exec = true
codex_hooks = false
plugins = false
remote_plugin = false
apps = false
code_mode = false
code_mode_host = false
use_legacy_landlock = false

[mcp_servers]
`;

export type CodexForbiddenLocalPath =
  | "local-environment"
  | "shell"
  | "unified-exec-disabled"
  | "missing-endpoint"
  | "stale-endpoint"
  | "command-hooks"
  | "legacy-notify"
  | "local-mcp-stdio"
  | "local-http-helper"
  | "unsafe-plugin-maintenance"
  | "program-executor"
  | "shared-app-server-daemon"
  | "danger-full-access"
  | "sandbox-bypass"
  | "remote-local-fallback";

export type CodexManagedPolicyMechanism =
  | "0.153.4-managed-requirements"
  | "trusted-launch-configuration"
  | "unsupported";

export interface CodexManagedPolicyBinding {
  readonly mechanism: CodexManagedPolicyMechanism;
  readonly requirementsPath: string;
  readonly mountTarget: "/etc/codex/requirements.toml";
  readonly environment: Readonly<Record<string, string>>;
  readonly forbiddenPaths: readonly CodexForbiddenLocalPath[];
  readonly projectLayerOverrideProof: "cannot-override" | "overrides" | "unproven";
}

export interface CodexRemoteOnlyConfiguration {
  readonly environment: Readonly<Record<string, string>>;
  readonly launchArguments: readonly ["-c", "notify=[]"];
  readonly managedPolicy: CodexManagedPolicyBinding;
  readonly endpoint: CodexSplitTransportBinding;
  readonly environmentId: "remote";
  readonly logicalCwd: "/workspace";
  readonly workspaceRoots: readonly ["/workspace"];
  readonly localEnvironmentAvailable: false;
  readonly unifiedExecRequired: true;
}

function absolutePath(value: string, errorCode: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(errorCode);
  return path.resolve(value);
}

function assertAdmittedEndpoint(endpoint: CodexSplitTransportBinding): void {
  const expectedUrl = `ws://codex-executor:${endpoint.endpointPort}`;
  let parsed: URL;
  try {
    parsed = new URL(endpoint.endpointUrl);
  } catch {
    throw new Error("codex-policy-endpoint-invalid");
  }
  if (endpoint.endpointHost !== "codex-executor"
    || endpoint.endpointUrl !== expectedUrl
    || parsed.protocol !== "ws:"
    || parsed.hostname !== "codex-executor"
    || parsed.port !== String(endpoint.endpointPort)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || !Number.isSafeInteger(endpoint.endpointPort)
    || endpoint.endpointPort < 1
    || endpoint.endpointPort > 65535) {
    throw new Error("codex-policy-endpoint-invalid");
  }
  if (endpoint.security === "unproven") throw new Error("codex-policy-endpoint-unproven");
}

function assertNativeHomeBinding(home: CodexNativeHomeBinding): void {
  if (home.mountTarget !== CODEX_HOME_TARGET || !path.isAbsolute(home.homePath) || home.homePath.includes("\0")) {
    throw new Error("codex-policy-native-home-invalid");
  }
}

function policyDirectory(stateRoot: string, endpoint: CodexSplitTransportBinding): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(endpoint.workspaceId)) {
    throw new Error("codex-policy-workspace-id-invalid");
  }
  if (!Number.isSafeInteger(endpoint.generation) || endpoint.generation < 1) {
    throw new Error("codex-policy-generation-invalid");
  }
  return assertContained(
    stateRoot,
    path.join(stateRoot, "codex-split-policies", `${endpoint.workspaceId}-g${endpoint.generation}`)
  );
}

async function writePinnedPolicy(filePath: string): Promise<void> {
  const expected = Buffer.from(MANAGED_REQUIREMENTS_TOML, "utf8");
  const existing = await lstatIdentity(filePath);
  if (existing !== null) {
    if (!existing.stats.isFile() || existing.stats.isSymbolicLink()
      || Number(existing.stats.mode & 0o777n) !== POLICY_FILE_MODE) {
      throw new Error("codex-policy-file-integrity");
    }
    const contents = await readRegularFileNoFollow(filePath, MAX_POLICY_BYTES);
    if (!contents.bytes.equals(expected)) throw new Error("codex-policy-content-mismatch");
    return;
  }

  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  try {
    descriptor = await open(filePath, "wx", POLICY_FILE_MODE);
    await descriptor.writeFile(expected);
    await descriptor.chmod(POLICY_FILE_MODE);
    await descriptor.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error("codex-policy-materialization-failed", { cause: error });
    }
  } finally {
    await descriptor?.close();
  }
  const contents = await readRegularFileNoFollow(filePath, MAX_POLICY_BYTES);
  if (Number(contents.stats.mode & 0o777n) !== POLICY_FILE_MODE || !contents.bytes.equals(expected)) {
    throw new Error("codex-policy-file-integrity");
  }
}

function hasAllForbiddenPaths(paths: readonly CodexForbiddenLocalPath[]): boolean {
  const values = new Set(paths);
  return FORBIDDEN_LOCAL_PATHS.every((pathValue) => values.has(pathValue));
}

function assertPolicyEndpointUrl(endpointUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new Error("codex-policy-endpoint-invalid");
  }
  if (parsed.protocol !== "ws:"
    || parsed.hostname !== "codex-executor"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || !parsed.port
    || `${parsed.protocol}//${parsed.hostname}:${parsed.port}` !== endpointUrl) {
    throw new Error("codex-policy-endpoint-invalid");
  }
}

function assertManagedPolicyShape(policy: CodexManagedPolicyBinding): void {
  if (policy.mechanism !== "0.153.4-managed-requirements"
    || policy.mountTarget !== REQUIREMENTS_TARGET
    || !path.isAbsolute(policy.requirementsPath)
    || policy.requirementsPath.includes("\0")
    || policy.projectLayerOverrideProof !== "cannot-override"
    || !hasAllForbiddenPaths(policy.forbiddenPaths)
    || policy.environment.CODEX_HOME !== CODEX_HOME_TARGET
    || policy.environment.HOME !== CODEX_HOME_TARGET
    || typeof policy.environment.CODEX_EXEC_SERVER_URL !== "string"
    || Object.keys(policy.environment).some((name) => !["CODEX_HOME", "HOME", "CODEX_EXEC_SERVER_URL"].includes(name))) {
    throw new Error("codex-policy-binding-invalid");
  }
  assertPolicyEndpointUrl(policy.environment.CODEX_EXEC_SERVER_URL);
}

function assertConfiguredEndpointMatches(
  policy: CodexManagedPolicyBinding,
  endpoint: CodexSplitTransportBinding
): void {
  const configuredEndpoint = policy.environment.CODEX_EXEC_SERVER_URL;
  if (configuredEndpoint === undefined || configuredEndpoint.trim() === "") {
    throw new Error("codex-policy-missing-endpoint");
  }
  if (configuredEndpoint === "none") throw new Error("codex-policy-remote-local-fallback");
  if (configuredEndpoint !== endpoint.endpointUrl) throw new Error("codex-policy-stale-endpoint");
}

function assertManagedPolicyBinding(policy: CodexManagedPolicyBinding, endpoint: CodexSplitTransportBinding): void {
  assertAdmittedEndpoint(endpoint);
  assertConfiguredEndpointMatches(policy, endpoint);
  assertManagedPolicyShape(policy);
}

export async function prepareCodexManagedPolicy(input: {
  readonly stateRoot: string;
  readonly home: CodexNativeHomeBinding;
  readonly endpoint: CodexSplitTransportBinding;
  readonly admittedVersion: "0.153.4";
}): Promise<CodexManagedPolicyBinding> {
  if (input.admittedVersion !== ADMITTED_CODEX_VERSION) throw new Error("codex-policy-version-not-admitted");
  const stateRoot = absolutePath(input.stateRoot, "codex-policy-state-root-invalid");
  assertNativeHomeBinding(input.home);
  assertAdmittedEndpoint(input.endpoint);
  const directory = policyDirectory(stateRoot, input.endpoint);
  await establishPinnedDirectory(directory);
  const requirementsPath = assertContained(directory, path.join(directory, "requirements.toml"));
  await writePinnedPolicy(requirementsPath);
  const policy: CodexManagedPolicyBinding = {
    mechanism: "0.153.4-managed-requirements",
    requirementsPath,
    mountTarget: REQUIREMENTS_TARGET,
    environment: {
      CODEX_HOME: CODEX_HOME_TARGET,
      HOME: CODEX_HOME_TARGET,
      CODEX_EXEC_SERVER_URL: input.endpoint.endpointUrl
    },
    forbiddenPaths: FORBIDDEN_LOCAL_PATHS,
    projectLayerOverrideProof: "cannot-override"
  };
  assertManagedPolicyBinding(policy, input.endpoint);
  return policy;
}

export function buildRemoteOnlyConfiguration(input: {
  readonly home: CodexNativeHomeBinding;
  readonly endpoint: CodexSplitTransportBinding;
  readonly policy: CodexManagedPolicyBinding;
}): CodexRemoteOnlyConfiguration {
  assertNativeHomeBinding(input.home);
  assertManagedPolicyBinding(input.policy, input.endpoint);
  return {
    environment: { ...input.policy.environment },
    launchArguments: ["-c", "notify=[]"],
    managedPolicy: input.policy,
    endpoint: input.endpoint,
    environmentId: REMOTE_ENVIRONMENT_ID,
    logicalCwd: LOGICAL_CWD,
    workspaceRoots: [LOGICAL_CWD],
    localEnvironmentAvailable: false,
    unifiedExecRequired: true
  };
}

function configHas(config: string, pattern: RegExp): boolean {
  return pattern.test(config);
}

function assertConfigNotContaining(config: string | null, pattern: RegExp, errorCode: CodexForbiddenLocalPath): void {
  if (config !== null && configHas(config, pattern)) throw new Error(`codex-policy-${errorCode}`);
}

export function assertNativeHomeEnvironmentOverride(input: {
  readonly homeConfig: string | null;
  readonly environmentToml: string | null;
  readonly endpoint: CodexSplitTransportBinding;
}): void {
  assertAdmittedEndpoint(input.endpoint);
  assertConfigNotContaining(input.homeConfig, /(?:^|[\r\n])\s*notify\s*=/imu, "legacy-notify");
  assertConfigNotContaining(input.homeConfig, /(?:^|[\r\n])\s*allow_login_shell\s*=\s*true\b/imu, "shell");
  assertConfigNotContaining(input.homeConfig, /(?:^|[\r\n])\s*allow_managed_hooks_only\s*=\s*false\b/imu, "command-hooks");
  assertConfigNotContaining(input.homeConfig, /(?:^|[\r\n])\s*(?:unified_exec|experimental_use_unified_exec_tool)\s*=\s*false\b/imu, "unified-exec-disabled");
  assertConfigNotContaining(input.homeConfig, /(?:^|[\r\n])\s*sandbox_mode\s*=\s*["']danger-full-access["']/imu, "danger-full-access");
  assertConfigNotContaining(input.homeConfig, /(?:^|[\r\n])\s*use_legacy_landlock\s*=\s*true\b/imu, "sandbox-bypass");
  if (input.homeConfig !== null
    && (configHas(input.homeConfig, /(?:^|[\r\n])\s*\[+mcp_servers[^\]]*\]/imu)
      || configHas(input.homeConfig, /(?:^|[\r\n])\s*mcp_servers\s*=/imu))) {
    if (configHas(input.homeConfig, /(?:^|[\r\n])\s*url\s*=/imu)) {
      throw new Error("codex-policy-local-http-helper");
    }
    throw new Error("codex-policy-local-mcp-stdio");
  }
  assertConfigNotContaining(input.homeConfig, /(?:^|[\r\n])\s*(?:plugins\s*=\s*true)|(?:^|[\r\n])\s*\[+plugins(?:[^\]]*)\]/imu, "unsafe-plugin-maintenance");
  assertConfigNotContaining(input.homeConfig, /(?:^|[\r\n])\s*(?:codex_hooks|plugins|remote_plugin)\s*=\s*true\b/imu, "unsafe-plugin-maintenance");
  assertConfigNotContaining(input.homeConfig, /(?:^|[\r\n])\s*(?:app_server|app-server|shared_daemon|daemon)\s*[=.]/imu, "shared-app-server-daemon");
  assertConfigNotContaining(input.homeConfig, /(?:^|[\r\n])\s*CODEX_EXEC_SERVER_URL\s*=\s*["'](?:none|\s*)["']/imu, "remote-local-fallback");

  if (input.environmentToml !== null && input.environmentToml.trim() !== "") {
    if (configHas(input.environmentToml, /(?:^|[\r\n])\s*program\s*=/imu)) {
      throw new Error("codex-policy-program-executor");
    }
    if (configHas(input.environmentToml, /(?:^|[\r\n])\s*(?:include_local\s*=\s*true|(?:default|id)\s*=\s*["']local["'])/imu)) {
      throw new Error("codex-policy-local-environment");
    }
    if (configHas(input.environmentToml, /CODEX_EXEC_SERVER_URL\s*=\s*["'](?:none|\s*)["']/iu)) {
      throw new Error("codex-policy-remote-local-fallback");
    }
    throw new Error("codex-policy-stale-endpoint");
  }
}

export function assertForbiddenProjectConfiguration(input: {
  readonly projectConfig: string;
  readonly policy: CodexManagedPolicyBinding;
}): void {
  assertManagedPolicyShape(input.policy);
  const config = input.projectConfig;
  assertConfigNotContaining(config, /(?:^|[\r\n])\s*program\s*=/imu, "program-executor");
  assertConfigNotContaining(config, /(?:^|[\r\n])\s*include_local\s*=\s*true|(?:^|[\r\n])\s*\[+environments(?:[^\]]*)\]/imu, "local-environment");
  assertConfigNotContaining(config, /\/shell\b|(?:^|[\r\n])\s*allow_login_shell\s*=\s*true\b/iu, "shell");
  assertConfigNotContaining(config, /(?:^|[\r\n])\s*(?:unified_exec|experimental_use_unified_exec_tool)\s*=\s*false\b/imu, "unified-exec-disabled");
  assertConfigNotContaining(config, /(?:^|[\r\n])\s*hooks\s*=|(?:^|[\r\n])\s*\[+hooks(?:[^\]]*)\]/imu, "command-hooks");
  assertConfigNotContaining(config, /(?:^|[\r\n])\s*notify\s*=/imu, "legacy-notify");
  if (configHas(config, /(?:^|[\r\n])\s*\[+mcp_servers[^\]]*\]/imu) || configHas(config, /(?:^|[\r\n])\s*mcp_servers\s*=/imu)) {
    if (configHas(config, /(?:^|[\r\n])\s*url\s*=/imu)) throw new Error("codex-policy-local-http-helper");
    throw new Error("codex-policy-local-mcp-stdio");
  }
  assertConfigNotContaining(config, /(?:^|[\r\n])\s*(?:plugins\s*=\s*true|\[+plugins[^\]]*\])/imu, "unsafe-plugin-maintenance");
  assertConfigNotContaining(config, /(?:^|[\r\n])\s*(?:app_server|app-server|shared_daemon|daemon)\s*[=.]/imu, "shared-app-server-daemon");
  assertConfigNotContaining(config, /(?:^|[\r\n])\s*sandbox_mode\s*=\s*["']danger-full-access["']/imu, "danger-full-access");
  assertConfigNotContaining(config, /(?:^|[\r\n])\s*use_legacy_landlock\s*=\s*true\b/imu, "sandbox-bypass");
  assertConfigNotContaining(config, /CODEX_EXEC_SERVER_URL\s*=\s*["'](?:none|\s*)["']/iu, "remote-local-fallback");
  assertConfigNotContaining(config, /(?:^|[\r\n])\s*environment_id\s*=\s*["']local["']/imu, "local-environment");
}
