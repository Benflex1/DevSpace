import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CodexNativeHomeBinding } from "./native-home.js";
import {
  assertForbiddenProjectConfiguration,
  assertNativeHomeEnvironmentOverride,
  assertEffectiveCodexPolicy,
  assertNativeCodexArgv,
  buildRemoteOnlyConfiguration,
  buildNativeCodexArgv,
  prepareCodexManagedPolicy,
  type CodexCodeModeConfiguration,
  type CodexManagedPolicyBinding
} from "./remote-policy.js";
import type { CodexSplitTransportBinding } from "./transport.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const workspaceId = "018f0f00-0000-7000-8000-000000000002";
const home: CodexNativeHomeBinding = {
  accountBinding: "owner-default",
  homePath: "/srv/devspace/codex-home",
  mountTarget: "/codex-home",
  identity: { device: "1", inode: "2" },
  ownerUid: 1000,
  ownerGid: 1000
};
const endpoint: CodexSplitTransportBinding = {
  endpointUrl: "ws://codex-executor:4545",
  endpointHost: "codex-executor",
  endpointPort: 4545,
  security: "private-network-only",
  authenticationEvidence: "absent",
  credential: null,
  workspaceId,
  generation: 7,
  executionNetworkId: "execution-network-id"
};

function policy(requirementsPath = "/srv/state/requirements.toml"): CodexManagedPolicyBinding {
  return {
    mechanism: "0.153.4-managed-requirements",
    requirementsPath,
    mountTarget: "/etc/codex/requirements.toml",
    managedConfigPath: "/srv/state/managed_config.toml",
    managedConfigMountTarget: "/etc/codex/managed_config.toml",
    environment: {
      CODEX_HOME: "/codex-home",
      HOME: "/codex-home",
      CODEX_EXEC_SERVER_URL: endpoint.endpointUrl
    },
    forbiddenPaths: [
      "local-environment", "shell", "unified-exec-disabled", "missing-endpoint", "stale-endpoint",
      "code-mode-host-missing", "code-mode-host-stale", "code-mode-fallback-enabled", "embedded-app-server",
      "command-hooks", "legacy-notify", "local-mcp-stdio", "local-http-helper",
      "unsafe-plugin-maintenance", "program-executor", "shared-app-server-daemon",
      "danger-full-access", "sandbox-bypass", "remote-local-fallback"
    ],
    projectLayerOverrideProof: "cannot-override"
  };
}

describe("Codex split remote-only policy", () => {
  const codeMode: CodexCodeModeConfiguration = {
    enabled: true,
    hostEnabled: true,
    disableInProcessFallback: true,
    remoteHostUrl: "http://codex-code-mode-host:4546"
  };

  test("materializes an exact managed requirements file without a recursive home deny", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-remote-policy-"));
    roots.push(root);
    const binding = await prepareCodexManagedPolicy({
      stateRoot: root,
      home,
      endpoint,
      admittedVersion: "0.153.4"
    });
    const contents = await readFile(binding.requirementsPath, "utf8");

    expect(binding.mechanism).toBe("0.153.4-managed-requirements");
    expect(binding.mountTarget).toBe("/etc/codex/requirements.toml");
    expect(binding.managedConfigMountTarget).toBe("/etc/codex/managed_config.toml");
    expect(binding.projectLayerOverrideProof).toBe("cannot-override");
    expect(contents).toContain('allowed_sandbox_modes = ["read-only", "workspace-write"]');
    expect(contents).toContain("allow_managed_hooks_only = true");
    expect(contents).toContain("unified_exec = true");
    expect(contents).toContain("codex_hooks = false");
    expect(contents).toContain("plugins = false");
    expect(contents).toContain("remote_plugin = false");
    expect(contents).toContain("use_legacy_landlock = false");
    expect(contents).toContain("code_mode = true");
    expect(contents).toContain("code_mode_host = true");
    expect(contents).not.toContain("[features.code_mode]");
    expect(contents).not.toContain("[features.code_mode_host]");
    expect(contents).toContain("[mcp_servers]");
    expect(contents).not.toContain("/codex-home/**");
    const managedConfig = await readFile(binding.managedConfigPath, "utf8");
    expect(managedConfig).toContain("[features.code_mode]");
    expect(managedConfig).toContain("enabled = true");
    expect(managedConfig).toContain("[features.code_mode_host]");
    expect(managedConfig).toContain("disable_in_process_fallback = true");
  });

  test("does not reuse the stale bare-TUI policy directory for the app-server composition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-remote-policy-stale-"));
    roots.push(root);
    const staleDirectory = path.join(root, "codex-split-policies", `${workspaceId}-g${endpoint.generation}`);
    await mkdir(staleDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(staleDirectory, "requirements.toml"), "[features]\ncode_mode = false\n", { mode: 0o600 });
    const previousCompositionDirectory = path.join(
      root,
      "codex-split-policies",
      `${workspaceId}-g${endpoint.generation}-native-app-server-code-mode-v1`
    );
    await mkdir(previousCompositionDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(previousCompositionDirectory, "requirements.toml"), "[features.code_mode]\nenabled = true\n", { mode: 0o600 });

    const binding = await prepareCodexManagedPolicy({
      stateRoot: root,
      home,
      endpoint,
      admittedVersion: "0.153.4"
    });

    expect(binding.requirementsPath).not.toBe(path.join(staleDirectory, "requirements.toml"));
    expect(binding.requirementsPath).not.toBe(path.join(previousCompositionDirectory, "requirements.toml"));
    expect(await readFile(binding.requirementsPath, "utf8")).toContain("code_mode_host = true");
    expect(await readFile(path.join(staleDirectory, "requirements.toml"), "utf8")).toContain("code_mode = false");
  });

  test("binds the native home to a remote-only logical workspace", () => {
    const configuration = buildRemoteOnlyConfiguration({ home, endpoint, policy: policy() });

    expect(configuration.environment).toEqual({
      CODEX_HOME: "/codex-home",
      HOME: "/codex-home",
      CODEX_EXEC_SERVER_URL: endpoint.endpointUrl
    });
    expect(configuration.environmentId).toBe("remote");
    expect(configuration.logicalCwd).toBe("/workspace");
    expect(configuration.workspaceRoots).toEqual(["/workspace"]);
    expect(configuration.localEnvironmentAvailable).toBe(false);
    expect(configuration.unifiedExecRequired).toBe(true);
    expect(configuration.codeMode).toEqual(codeMode);
    expect(configuration.launchArguments).toEqual([]);
  });

  test("requires the exact remote Code Mode managed requirements", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-remote-policy-code-mode-"));
    roots.push(root);
    const binding = await prepareCodexManagedPolicy({
      stateRoot: root,
      home,
      endpoint,
      admittedVersion: "0.153.4"
    });
    const contents = await readFile(binding.requirementsPath, "utf8");
    expect(contents).toContain("code_mode = true");
    expect(contents).toContain("code_mode_host = true");
    expect(contents).not.toContain("disable_in_process_fallback");
    expect(contents).not.toContain("code_mode = false");
    expect(contents).not.toContain("code_mode_host = false");
  });

  test.each([
    [null, ["codex"]],
    ["018f0f00-0000-7000-8000-000000000003", ["codex", "resume", "018f0f00-0000-7000-8000-000000000003"]]
  ] as const)("builds the exact native argv for %s", (resumeSessionId, expected) => {
    expect(buildNativeCodexArgv(resumeSessionId)).toEqual(expected);
    expect(() => assertNativeCodexArgv(expected, resumeSessionId)).not.toThrow();
  });

  test.each([
    ["codex", ["-c", "notify=[]"]],
    ["codex", ["--remote", "http://example.invalid"]],
    ["codex", ["--profile", "default"]],
    ["codex", ["--strict-config"]],
    ["codex", ["--enable", "foo"]],
    ["codex", ["--disable", "foo"]]
  ] as const)("rejects native launch override %s", (command, suffix) => {
    expect(() => assertNativeCodexArgv([command, ...suffix], null)).toThrow("codex-native-argv");
  });

  test("does not accept diagnostic notify override as default-daemon evidence", () => {
    expect(() => assertNativeCodexArgv(["codex", "-c", "notify=[]"], null)).toThrow("codex-native-argv");
  });

  test("rejects a project layer that attempts to override the trusted Code Mode policy", () => {
    expect(() => assertEffectiveCodexPolicy({
      nativeConfigText: "[features.code_mode]\nenabled = true\n[features.code_mode_host]\nenabled = true\ndisable_in_process_fallback = true",
      projectConfigTexts: [
        "[features]\nunified_exec = false\n[features.code_mode_host]\nenabled = false\ndisable_in_process_fallback = false\n[hooks]\nnotify = [\"sh\"]\n[mcp_servers.bad]\ncommand = \"node\"\n[environments.local]\nprogram = \"/bin/sh\"\nsandbox_mode = \"danger-full-access\"\nCODEX_EXEC_SERVER_URL = \"none\""
      ],
      expected: codeMode
    })).toThrow(/codex-policy/u);
  });

  test("accepts only a complete trusted effective Code Mode policy", () => {
    const proof = assertEffectiveCodexPolicy({
      nativeConfigText: "[features]\nunified_exec = true\n[features.code_mode]\nenabled = true\n[features.code_mode_host]\nenabled = true\ndisable_in_process_fallback = true",
      projectConfigTexts: ["model = \"gpt-6-astra\"\n"],
      expected: codeMode
    });
    expect(proof.nativeConfig).toBe("managed");
    expect(proof.projectConfig).toBe("cannot-override");
    expect(proof.effective).toEqual(codeMode);
  });

  test("rejects missing, empty, stale, and disabled executor endpoint configuration", () => {
    for (const value of [undefined, "", "none", "ws://wrong:1"]) {
      const environment = { ...policy().environment };
      if (value === undefined) delete environment.CODEX_EXEC_SERVER_URL;
      else environment.CODEX_EXEC_SERVER_URL = value;
      expect(() => buildRemoteOnlyConfiguration({
        home,
        endpoint,
        policy: { ...policy(), environment }
      })).toThrow(/missing-endpoint|stale-endpoint|remote-local-fallback/u);
    }
  });

  test("rejects native/global endpoint, local, program, and legacy notifier overrides", () => {
    expect(() => assertNativeHomeEnvironmentOverride({
      homeConfig: 'notify = ["sh"]', environmentToml: null, endpoint
    })).toThrow("legacy-notify");
    expect(() => assertNativeHomeEnvironmentOverride({
      homeConfig: null,
      environmentToml: 'include_local = true\n[[environments]]\nid = "local"\nprogram = "/bin/sh"',
      endpoint
    })).toThrow("program-executor");
    expect(() => assertNativeHomeEnvironmentOverride({
      homeConfig: null,
      environmentToml: `include_local = false\ndefault = "other"\n[[environments]]\nid = "other"\nurl = "ws://wrong:1"`,
      endpoint
    })).toThrow("stale-endpoint");
  });

  const forbiddenFixtures: Readonly<Record<string, string>> = {
    "local-environment": "[environments]\ninclude_local = true",
    shell: "# /shell local escape",
    "unified-exec-disabled": "[features]\nunified_exec = false",
    "command-hooks": "[hooks]\n",
    "legacy-notify": "notify = [\"sh\"]",
    "local-mcp-stdio": "[mcp_servers.local]\ncommand = \"node\"",
    "local-http-helper": "[mcp_servers.local]\nurl = \"http://127.0.0.1:1\"",
    "unsafe-plugin-maintenance": "[features]\nplugins = true\n[plugins.demo]\nenabled = true",
    "program-executor": "[[environments]]\nid = \"local\"\nprogram = \"/bin/sh\"",
    "shared-app-server-daemon": "app_server = \"shared\"",
    "danger-full-access": "sandbox_mode = \"danger-full-access\"",
    "sandbox-bypass": "[features]\nuse_legacy_landlock = true",
    "remote-local-fallback": "CODEX_EXEC_SERVER_URL = \"none\""
  };

  test.each(Object.entries(forbiddenFixtures))("rejects project configuration for %s", (forbiddenPath, projectConfig) => {
    expect(() => assertForbiddenProjectConfiguration({ projectConfig, policy: policy() }))
      .toThrow(forbiddenPath);
  });

  const globalForbiddenFixtures: Readonly<Record<string, {
    readonly homeConfig: string | null;
    readonly environmentToml: string | null;
  }>> = {
    "local-environment": { homeConfig: null, environmentToml: "include_local = true" },
    shell: { homeConfig: "allow_login_shell = true", environmentToml: null },
    "unified-exec-disabled": { homeConfig: "[features]\nunified_exec = false", environmentToml: null },
    "command-hooks": { homeConfig: "allow_managed_hooks_only = false", environmentToml: null },
    "legacy-notify": { homeConfig: "notify = [\"sh\"]", environmentToml: null },
    "local-mcp-stdio": { homeConfig: "[mcp_servers.local]\ncommand = \"node\"", environmentToml: null },
    "local-http-helper": { homeConfig: "[mcp_servers.local]\nurl = \"http://127.0.0.1:1\"", environmentToml: null },
    "unsafe-plugin-maintenance": { homeConfig: "[plugins.demo]\nenabled = true", environmentToml: null },
    "program-executor": { homeConfig: null, environmentToml: "[[environments]]\nprogram = \"/bin/sh\"" },
    "shared-app-server-daemon": { homeConfig: "app_server = \"shared\"", environmentToml: null },
    "danger-full-access": { homeConfig: "sandbox_mode = \"danger-full-access\"", environmentToml: null },
    "sandbox-bypass": { homeConfig: "[features]\nuse_legacy_landlock = true", environmentToml: null },
    "remote-local-fallback": { homeConfig: "CODEX_EXEC_SERVER_URL = \"none\"", environmentToml: null }
  };

  test.each(Object.entries(globalForbiddenFixtures))("rejects native/global configuration for %s", (forbiddenPath, fixture) => {
    expect(() => assertNativeHomeEnvironmentOverride({ ...fixture, endpoint }))
      .toThrow(forbiddenPath);
  });

  test("accepts a project layer that contains no forbidden execution controls", () => {
    expect(() => assertForbiddenProjectConfiguration({
      projectConfig: 'model = "gpt-5-codex"\n[features]\npersonality = true\n',
      policy: policy()
    })).not.toThrow();
  });
});
