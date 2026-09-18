import { open } from "node:fs/promises";
import path from "node:path";
import { assertContained, establishPinnedDirectory, lstatIdentity, readRegularFileNoFollow } from "../private-state.js";
import type { CodexNativeHomeBinding } from "./native-home.js";
import type { CodexSplitTransportBinding } from "./transport.js";

const ADMITTED_CODEX_VERSION = "0.153.4" as const;
const CODEX_HOME_TARGET = "/codex-home" as const;
const LOGICAL_CWD = "/workspace" as const;
const REMOTE_ENVIRONMENT_ID = "remote" as const;
export const CODEX_CODE_MODE_HOST_URL = "http://codex-code-mode-host:4546" as const;
const REQUIREMENTS_TARGET = "/etc/codex/requirements.toml" as const;
const MANAGED_CONFIG_TARGET = "/etc/codex/managed_config.toml" as const;
const POLICY_COMPOSITION_NAMESPACE = "native-app-server-code-mode-v2" as const;
const POLICY_FILE_MODE = 0o600;
const MAX_POLICY_BYTES = 16 * 1024;

const FORBIDDEN_LOCAL_PATHS = [
  "local-environment",
  "shell",
  "unified-exec-disabled",
  "missing-endpoint",
  "stale-endpoint",
  "code-mode-host-missing",
  "code-mode-host-stale",
  "code-mode-fallback-enabled",
  "embedded-app-server",
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
use_legacy_landlock = false
code_mode = true
code_mode_host = true

[mcp_servers]
`;

const MANAGED_CONFIG_TOML = `# Agent-owned Codex split effective configuration for admitted Codex ${ADMITTED_CODEX_VERSION}.
[features.code_mode]
enabled = true

[features.code_mode_host]
enabled = true
disable_in_process_fallback = true
`;

export type CodexForbiddenLocalPath =
  | "local-environment"
  | "shell"
  | "unified-exec-disabled"
  | "missing-endpoint"
  | "stale-endpoint"
  | "code-mode-host-missing"
  | "code-mode-host-stale"
  | "code-mode-fallback-enabled"
  | "embedded-app-server"
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
  readonly managedConfigPath: string;
  readonly managedConfigMountTarget: "/etc/codex/managed_config.toml";
  readonly environment: Readonly<Record<string, string>>;
  readonly forbiddenPaths: readonly CodexForbiddenLocalPath[];
  readonly projectLayerOverrideProof: "cannot-override" | "overrides" | "unproven";
}

export interface CodexCodeModeConfiguration {
  readonly enabled: true;
  readonly hostEnabled: true;
  readonly disableInProcessFallback: true;
  readonly remoteHostUrl: string;
}

export interface CodexRemoteOnlyConfiguration {
  readonly environment: Readonly<Record<string, string>>;
  readonly launchArguments: readonly [];
  readonly managedPolicy: CodexManagedPolicyBinding;
  readonly endpoint: CodexSplitTransportBinding;
  readonly environmentId: "remote";
  readonly logicalCwd: "/workspace";
  readonly workspaceRoots: readonly ["/workspace"];
  readonly localEnvironmentAvailable: false;
  readonly unifiedExecRequired: true;
  readonly codeMode: CodexCodeModeConfiguration;
}

export interface CodexEffectivePolicyProof {
  readonly nativeConfig: "managed";
  readonly projectConfig: "cannot-override";
  readonly effective: CodexCodeModeConfiguration;
  readonly forbiddenLocalPaths: readonly CodexForbiddenLocalPath[];
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
    path.join(stateRoot, "codex-split-policies", `${endpoint.workspaceId}-g${endpoint.generation}-${POLICY_COMPOSITION_NAMESPACE}`)
  );
}

async function writePinnedPolicy(filePath: string, expectedText: string): Promise<void> {
  const expected = Buffer.from(expectedText, "utf8");
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

function assertCodeModeHostUrl(endpointUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new Error("codex-policy-code-mode-host-invalid");
  }
  if (parsed.protocol !== "http:"
    || parsed.hostname !== "codex-code-mode-host"
    || !parsed.port
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || `${parsed.protocol}//${parsed.hostname}:${parsed.port}` !== endpointUrl
    || !Number.isSafeInteger(Number(parsed.port))
    || Number(parsed.port) < 1
    || Number(parsed.port) > 65535) {
    throw new Error("codex-policy-code-mode-host-invalid");
  }
}

function assertCodeModeConfiguration(codeMode: CodexCodeModeConfiguration): void {
  if (codeMode.enabled !== true
    || codeMode.hostEnabled !== true
    || codeMode.disableInProcessFallback !== true) {
    throw new Error("codex-policy-code-mode-fallback-enabled");
  }
  assertCodeModeHostUrl(codeMode.remoteHostUrl);
}

function assertManagedPolicyShape(policy: CodexManagedPolicyBinding): void {
  if (policy.mechanism !== "0.153.4-managed-requirements"
    || policy.mountTarget !== REQUIREMENTS_TARGET
    || !path.isAbsolute(policy.requirementsPath)
    || policy.requirementsPath.includes("\0")
    || policy.managedConfigMountTarget !== MANAGED_CONFIG_TARGET
    || !path.isAbsolute(policy.managedConfigPath)
    || policy.managedConfigPath.includes("\0")
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
  const managedConfigPath = assertContained(directory, path.join(directory, "managed_config.toml"));
  await writePinnedPolicy(requirementsPath, MANAGED_REQUIREMENTS_TOML);
  await writePinnedPolicy(managedConfigPath, MANAGED_CONFIG_TOML);
  const policy: CodexManagedPolicyBinding = {
    mechanism: "0.153.4-managed-requirements",
    requirementsPath,
    mountTarget: REQUIREMENTS_TARGET,
    managedConfigPath,
    managedConfigMountTarget: MANAGED_CONFIG_TARGET,
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
  readonly codeModeHostUrl?: string;
}): CodexRemoteOnlyConfiguration {
  assertNativeHomeBinding(input.home);
  assertManagedPolicyBinding(input.policy, input.endpoint);
  const remoteHostUrl = input.codeModeHostUrl ?? CODEX_CODE_MODE_HOST_URL;
  assertCodeModeHostUrl(remoteHostUrl);
  return {
    environment: { ...input.policy.environment },
    launchArguments: [],
    managedPolicy: input.policy,
    endpoint: input.endpoint,
    environmentId: REMOTE_ENVIRONMENT_ID,
    logicalCwd: LOGICAL_CWD,
    workspaceRoots: [LOGICAL_CWD],
    localEnvironmentAvailable: false,
    unifiedExecRequired: true,
    codeMode: {
      enabled: true,
      hostEnabled: true,
      disableInProcessFallback: true,
      remoteHostUrl
    }
  };
}

function containsAny(config: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(config));
}

function assertManagedCodeModeConfig(config: string, role: "native" | "project"): void {
  const prefix = role === "native" ? "codex-policy-native" : "codex-policy-project";
  if (!/(?:^|[\r\n])\s*unified_exec\s*=\s*true\b/imu.test(config)
    || !/(?:^|[\r\n])\s*\[features\.code_mode\]\s*[\r\n]+\s*enabled\s*=\s*true\b/imu.test(config)
    || !/(?:^|[\r\n])\s*\[features\.code_mode_host\]\s*[\r\n]+\s*enabled\s*=\s*true\b/imu.test(config)
    || !/(?:^|[\r\n])\s*disable_in_process_fallback\s*=\s*true\b/imu.test(config)) {
    throw new Error(`${prefix}-code-mode-policy`);
  }
  if (containsAny(config, [
    /(?:^|[\r\n])\s*code_mode\s*=\s*false\b/imu,
    /(?:^|[\r\n])\s*code_mode_host\s*=\s*false\b/imu,
    /(?:^|[\r\n])\s*disable_in_process_fallback\s*=\s*false\b/imu,
    /(?:^|[\r\n])\s*use_in_process_fallback\s*=\s*true\b/imu,
    /(?:^|[\r\n])\s*environment_id\s*=\s*["']local["']/imu,
    /(?:^|[\r\n])\s*CODEX_EXEC_SERVER_URL\s*=\s*["'](?:none|\s*)["']/imu
  ])) {
    throw new Error(`${prefix}-code-mode-policy`);
  }
}

function assertProjectLayerCannotOverride(config: string): void {
  if (config.trim() === "") return;
  if (containsAny(config, [
    /(?:^|[\r\n])\s*(?:unified_exec|experimental_use_unified_exec_tool)\s*=\s*false\b/imu,
    /(?:^|[\r\n])\s*code_mode\s*=\s*false\b/imu,
    /(?:^|[\r\n])\s*code_mode_host\s*=\s*false\b/imu,
    /(?:^|[\r\n])\s*disable_in_process_fallback\s*=\s*false\b/imu,
    /(?:^|[\r\n])\s*allow_login_shell\s*=\s*true\b/imu,
    /(?:^|[\r\n])\s*notify\s*=/imu,
    /(?:^|[\r\n])\s*hooks\s*=/imu,
    /(?:^|[\r\n])\s*\[+hooks[^\]]*\]/imu,
    /(?:^|[\r\n])\s*(?:program\s*=|\[+environments[^\]]*\])/imu,
    /(?:^|[\r\n])\s*\[+mcp_servers[^\]]*\]/imu,
    /(?:^|[\r\n])\s*mcp_servers\s*=/imu,
    /(?:^|[\r\n])\s*(?:plugins\s*=\s*true|\[+plugins[^\]]*\])/imu,
    /(?:^|[\r\n])\s*sandbox_mode\s*=\s*["']danger-full-access["']/imu,
    /(?:^|[\r\n])\s*use_legacy_landlock\s*=\s*true\b/imu,
    /(?:^|[\r\n])\s*CODEX_EXEC_SERVER_URL\s*=\s*["'](?:none|\s*)["']/imu,
    /(?:^|[\r\n])\s*(?:app_server|app-server|shared_daemon|daemon)\s*[=.]/imu,
    /\/shell\b/iu
  ])) {
    throw new Error("codex-policy-project-override");
  }
}

export function assertEffectiveCodexPolicy(input: {
  readonly nativeConfigText: string;
  readonly projectConfigTexts: readonly string[];
  readonly expected: CodexCodeModeConfiguration;
}): CodexEffectivePolicyProof {
  assertCodeModeConfiguration(input.expected);
  assertManagedCodeModeConfig(input.nativeConfigText, "native");
  for (const projectConfigText of input.projectConfigTexts) assertProjectLayerCannotOverride(projectConfigText);
  return {
    nativeConfig: "managed",
    projectConfig: "cannot-override",
    effective: { ...input.expected },
    forbiddenLocalPaths: FORBIDDEN_LOCAL_PATHS
  };
}

export function buildNativeCodexArgv(resumeSessionId: string | null): readonly string[] {
  if (resumeSessionId === null) return ["codex"];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(resumeSessionId)) {
    throw new Error("codex-native-argv");
  }
  return ["codex", "resume", resumeSessionId];
}

export function assertNativeCodexArgv(
  argv: readonly string[],
  expectedResumeSessionId: string | null,
): void {
  const expected = buildNativeCodexArgv(expectedResumeSessionId);
  if (argv.length !== expected.length || argv.some((value, index) => value !== expected[index])) {
    throw new Error("codex-native-argv");
  }
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
