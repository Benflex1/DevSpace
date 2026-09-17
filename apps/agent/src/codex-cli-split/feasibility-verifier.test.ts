import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  CODEX_SPLIT_VERIFY_ENV,
  buildCodexSplitManualChecklist,
  createCodexSplitTerminalOperator,
  formatCodexSplitDiagnostic,
  hasNoExternalDefaultRoute,
  parseCodexSplitOperatorAnswer,
  parseCodexSplitVerifyEnvironment,
  runCodexSplitFeasibilityGate,
  type CodexSplitVerifierServices
} from "./feasibility-verifier.js";
import { DockerEngineClient } from "../docker-runtime.js";
import { ManagedWorkspaces } from "../managed-workspaces.js";
import { CodexSplitRuntime } from "./split-runtime.js";
import type { CodexNativeHomeBinding } from "./native-home.js";
import type { CodexSplitRuntimeRecord } from "./runtime-record.js";

const digest = "a".repeat(64);
const validEnvironment: NodeJS.ProcessEnv = {
  DEVSPACE_TEST_DOCKER_SOCKET_PATH: "/run/user/1000/docker.sock",
  DEVSPACE_MANAGED_ROOT: "/var/lib/devspace",
  DEVSPACE_CODEX_EXECUTABLE_PATH: "/opt/codex/bin/codex",
  DEVSPACE_CODEX_CONTROL_IMAGE_REFERENCE: `registry.example/codex-control@sha256:${digest}`,
  DEVSPACE_CODEX_VERIFY_PROJECT_ID: "018f0f00-0000-7000-8000-000000000001",
  DEVSPACE_CODEX_VERIFY_WORKSPACE_ID: "018f0f00-0000-7000-8000-000000000002"
};

test("requires exactly the explicit opt-in environment and parses immutable paths/IDs", () => {
  expect(parseCodexSplitVerifyEnvironment(validEnvironment)).toEqual({
    dockerSocketPath: "/run/user/1000/docker.sock",
    managedRoot: "/var/lib/devspace",
    codexExecutablePath: "/opt/codex/bin/codex",
    controlImageReference: validEnvironment.DEVSPACE_CODEX_CONTROL_IMAGE_REFERENCE,
    projectId: validEnvironment.DEVSPACE_CODEX_VERIFY_PROJECT_ID,
    workspaceId: validEnvironment.DEVSPACE_CODEX_VERIFY_WORKSPACE_ID
  });
  expect(CODEX_SPLIT_VERIFY_ENV).toHaveLength(6);
  for (const name of CODEX_SPLIT_VERIFY_ENV) {
    const missing = { ...validEnvironment };
    delete missing[name];
    expect(() => parseCodexSplitVerifyEnvironment(missing)).toThrow("codex-split-verify-");
  }
});

test("rejects empty/relative values, host-socket fallbacks, mutable images, and invalid IDs", () => {
  expect(() => parseCodexSplitVerifyEnvironment({ ...validEnvironment, DEVSPACE_MANAGED_ROOT: "relative" }))
    .toThrow("managed-root");
  expect(() => parseCodexSplitVerifyEnvironment({ ...validEnvironment, DEVSPACE_CODEX_EXECUTABLE_PATH: "" }))
    .toThrow("codex-executable-path-missing");
  expect(() => parseCodexSplitVerifyEnvironment({ ...validEnvironment, DEVSPACE_TEST_DOCKER_SOCKET_PATH: "/var/run/docker.sock" }))
    .toThrow("docker-socket");
  expect(() => parseCodexSplitVerifyEnvironment({ ...validEnvironment, DEVSPACE_CODEX_CONTROL_IMAGE_REFERENCE: "latest" }))
    .toThrow("control-image");
  expect(() => parseCodexSplitVerifyEnvironment({ ...validEnvironment, DEVSPACE_CODEX_VERIFY_PROJECT_ID: "project" }))
    .toThrow("project-id");
});

test("prints the manual checklist outside the TUI and bounds diagnostics without secret/path output", () => {
  const checklist = buildCodexSplitManualChecklist();
  expect(checklist).toContain("A. Control plane");
  expect(checklist).toContain("pwd");
  expect(checklist).toContain("codex resume NATIVE_SESSION_ID");
  expect(checklist).not.toContain("PRIVATE");

  const diagnostic = formatCodexSplitDiagnostic("preflight", new Error("token=PRIVATE path=/private/home"), "executor");
  expect(diagnostic).toMatchObject({ phase: "preflight", resourceRole: "executor", exceptionClass: "Error" });
  expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
  expect(JSON.stringify(diagnostic)).not.toContain("/private/home");
  expect(String(diagnostic.stackContext).length).toBeLessThanOrEqual(1024);
});

test("includes bounded safe cause reasons in live diagnostics", () => {
  const error = new Error("codex-control-start-failed", {
    cause: new Error("codex-control-container-start", { cause: new Error("token=PRIVATE") })
  });
  const diagnostic = formatCodexSplitDiagnostic("live-gate", error, "control");
  expect(diagnostic.stackContext).toContain("CAUSE_1: codex-control-container-start");
  expect(diagnostic.stackContext).toContain("CAUSE_2: unexpected-failure");
  expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
  expect(String(diagnostic.stackContext).length).toBeLessThanOrEqual(1024);
});

test("accepts an internal-only executor default route but rejects an external route", () => {
  expect(hasNoExternalDefaultRoute("default via 172.30.0.1 dev eth0\n172.30.0.0/16 dev eth0", "172.30.0.1")).toBe(true);
  expect(hasNoExternalDefaultRoute("172.30.0.0/16 dev eth0", "172.30.0.1")).toBe(true);
  expect(hasNoExternalDefaultRoute("default via 10.0.0.1 dev eth0", "172.30.0.1")).toBe(false);
  expect(hasNoExternalDefaultRoute("default dev eth0", "172.30.0.1")).toBe(false);
});

test("requires an explicit final operator answer", () => {
  expect(parseCodexSplitOperatorAnswer(" PASS\n")).toBe("PASS");
  expect(parseCodexSplitOperatorAnswer("FAIL")).toBe("FAIL");
  expect(() => parseCodexSplitOperatorAnswer("continue")).toThrow("codex-split-operator-answer-invalid");
});

test("treats Control-C during final confirmation as an abort", async () => {
  const confirmation = createCodexSplitTerminalOperator().confirmFinalResult();
  process.stdin.emit("data", Buffer.from([0x03]));
  await expect(confirmation).rejects.toThrow("codex-split-operator-aborted");
});

test("does not attach the TUI when the runtime preflight fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-codex-verifier-preflight-"));
  try {
    const executablePath = path.join(root, "codex");
    await writeFile(executablePath, "#!/bin/sh\nprintf 'codex-cli 0.153.4\\n'\n", { mode: 0o700 });
    await chmod(executablePath, 0o700);
    const managed = new ManagedWorkspaces({
      projects: path.join(root, "projects"), workspaces: path.join(root, "workspaces"), state: path.join(root, "state")
    });
    const docker = new DockerEngineClient(path.join(root, "docker.sock"));
    let ensured = false;
    let attached = false;
    class FailingRuntime extends CodexSplitRuntime {
      override ensure(_input: { readonly projectId: string; readonly workspaceId: string }): Promise<CodexSplitRuntimeRecord> {
        ensured = true;
        return Promise.reject(new Error("codex-split-test-preflight"));
      }
    }
    const services: CodexSplitVerifierServices = {
      docker,
      managed,
      runtime: new FailingRuntime({
        managed, docker, stateRoot: path.join(root, "state"),
        controlImageReference: validEnvironment.DEVSPACE_CODEX_CONTROL_IMAGE_REFERENCE!, codexExecutablePath: executablePath
      }),
      home: {
        accountBinding: "owner-default", homePath: path.join(root, "native-home"), mountTarget: "/codex-home",
        identity: { device: "1", inode: "2" }, ownerUid: 1000, ownerGid: 1000
      } satisfies CodexNativeHomeBinding
    };
    const evidence = await runCodexSplitFeasibilityGate({
      configuration: parseCodexSplitVerifyEnvironment({ ...validEnvironment, DEVSPACE_CODEX_EXECUTABLE_PATH: executablePath }),
      services,
      operator: {
        printChecklist: () => undefined,
        attach: () => { attached = true; return Promise.resolve("exited" as const); },
        confirmFinalResult: () => Promise.resolve("PASS" as const)
      }
    });
    expect(ensured).toBe(true);
    expect(attached).toBe(false);
    expect(evidence.incompleteReason).toBe("codex-split-test-preflight");
    expect(evidence.securityViolation).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
