import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CodexNativeHomeBinding } from "./native-home.js";
import {
  assertForbiddenProjectConfiguration,
  assertNativeHomeEnvironmentOverride,
  buildRemoteOnlyConfiguration,
  prepareCodexManagedPolicy,
  type CodexForbiddenLocalPath,
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
    environment: {
      CODEX_HOME: "/codex-home",
      HOME: "/codex-home",
      CODEX_EXEC_SERVER_URL: endpoint.endpointUrl
    },
    forbiddenPaths: [
      "local-environment", "shell", "unified-exec-disabled", "missing-endpoint", "stale-endpoint",
      "command-hooks", "legacy-notify", "local-mcp-stdio", "local-http-helper",
      "unsafe-plugin-maintenance", "program-executor", "shared-app-server-daemon",
      "danger-full-access", "sandbox-bypass", "remote-local-fallback"
    ],
    projectLayerOverrideProof: "cannot-override"
  };
}

describe("Codex split remote-only policy", () => {
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
    expect(binding.projectLayerOverrideProof).toBe("cannot-override");
    expect(contents).toContain('allowed_sandbox_modes = ["read-only", "workspace-write"]');
    expect(contents).toContain("allow_managed_hooks_only = true");
    expect(contents).toContain("unified_exec = true");
    expect(contents).toContain("codex_hooks = false");
    expect(contents).toContain("plugins = false");
    expect(contents).toContain("remote_plugin = false");
    expect(contents).toContain("use_legacy_landlock = false");
    expect(contents).toContain("[mcp_servers]");
    expect(contents).not.toContain("/codex-home/**");
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
    expect(configuration.launchArguments).toEqual(["-c", "notify=[]"]);
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

  const forbiddenFixtures: Readonly<Record<Exclude<CodexForbiddenLocalPath, "missing-endpoint" | "stale-endpoint">, string>> = {
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

  const globalForbiddenFixtures: Readonly<Record<Exclude<CodexForbiddenLocalPath, "missing-endpoint" | "stale-endpoint">, {
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
