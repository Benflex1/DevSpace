import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  CODEX_SPLIT_VERIFY_ENV,
  buildCodexSplitCanaryProbeScript,
  buildCodexSplitManualChecklist,
  createCodexSplitTerminalOperator,
  endpointFromRecord,
  formatCodexSplitDiagnostic,
  hasCompleteProcessObservations,
  hasExpectedDefaultRoute,
  hasNoExternalDefaultRoute,
  hasNoExternallyReachableTcpListener,
  parseCodexSplitOperatorAnswer,
  parseCodexSplitVerifyEnvironment,
  runCodexSplitFeasibilityGate,
  runCodexSplitFeasibilityPreflight,
  type CodexSplitVerifierServices
} from "./feasibility-verifier.js";
import { DockerEngineClient } from "../docker-runtime.js";
import { ManagedWorkspaces } from "../managed-workspaces.js";
import { CodexSplitRuntime } from "./split-runtime.js";
import type { CodexNativeHomeBinding } from "./native-home.js";
import { parseCodexSplitRuntimeRecord, type CodexSplitRuntimeRecord } from "./runtime-record.js";

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

test("parses procfs IPv4 routes for control and executor route proofs", () => {
  const procRoutes = [
    "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
    "eth0\t00000000\t01001EAC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
    "eth0\t00001EAC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0"
  ].join("\n");
  expect(hasExpectedDefaultRoute(procRoutes, "172.30.0.1")).toBe(true);
  expect(hasNoExternalDefaultRoute(procRoutes, "172.30.0.1")).toBe(true);
  expect(hasExpectedDefaultRoute(procRoutes, "172.30.1.1")).toBe(false);
  expect(hasNoExternalDefaultRoute(procRoutes, "172.30.1.1")).toBe(false);
});

test("treats loopback proc listeners as local but rejects wildcard listeners", () => {
  const procSockets = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0B00007F:95A3 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 2 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 2 0000000000000000 100 0 0 10 0"
  ].join("\n");
  expect(hasNoExternallyReachableTcpListener(procSockets)).toBe(true);
  expect(hasNoExternallyReachableTcpListener(procSockets.replace("0B00007F", "00000000"))).toBe(false);
});

test("canary probe checks proc environment contents without requiring proc to be unreadable", () => {
  const script = buildCodexSplitCanaryProbeScript({
    canaryPath: "/codex-home/sentinel",
    linkPath: "/workspace/.sentinel-link",
    basename: "sentinel"
  });
  expect(script).not.toContain("test ! -r '/proc/1/environ'");
  expect(script).toContain("tr '\\0' '\\n' </proc/1/environ");
  expect(script).toContain("/proc/1/root/codex-home/sentinel");
});

test("does not treat an unobserved zero process count as a process proof", () => {
  expect(hasCompleteProcessObservations([
    { role: "control", projectProcessCount: 0, observationComplete: false },
    { role: "executor", projectProcessCount: 0, observationComplete: true }
  ])).toBe(false);
  expect(hasCompleteProcessObservations([
    { role: "control", projectProcessCount: 0, observationComplete: true },
    { role: "executor", projectProcessCount: 0, observationComplete: true }
  ])).toBe(true);
});

test("round-trips the current persisted transport record through endpointFromRecord", () => {
  const record: CodexSplitRuntimeRecord = {
    version: 2,
    projectId: "018f0f00-0000-7000-8000-000000000001",
    workspaceId: "018f0f00-0000-7000-8000-000000000002",
    revisionId: "018f0f00-0000-7000-8000-000000000003",
    runtimePlanHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    generation: 1,
    networks: {
      execution: {
        id: "execution-id", name: "devspace-codex-execution", role: "execution", internal: true, defaultRoute: false
      },
      controlEgress: {
        id: "egress-id", name: "devspace-codex-egress", role: "control-egress", internal: false, defaultRoute: true
      }
    },
    artifact: {
      packageVersion: "0.153.4", closureDigest: "d".repeat(64), nativeCliPath: "/opt/devspace/codex/bin/codex",
      execServerCapability: "codex-0.153.4-exec-server", appServerCapability: "codex-0.153.4-app-server",
      codeModeHostCapability: "codex-0.153.4-code-mode-host"
    },
    executor: {
      id: "executor-id", imageId: `sha256:${"b".repeat(64)}`, imageReference: "node@sha256:" + "b".repeat(64),
      imageArchitecture: "amd64", worktreeIdentity: { device: "1", inode: "3" },
      repositoryIdentity: { device: "1", inode: "4" }, administrationIdentity: { device: "1", inode: "5" },
      endpointUrl: "ws://codex-executor:4545", transportSecurity: "private-network-only"
    },
    execServer: {
      executorContainerId: "executor-id", execId: "server-exec", endpointUrl: "ws://codex-executor:4545",
      serverPid: 11, transportSecurity: "private-network-only"
    },
    codeModeHost: {
      executorContainerId: "executor-id", execId: "code-mode-exec", serverPid: 12,
      host: "codex-code-mode-host", port: 4546, url: "http://codex-code-mode-host:4546",
      listenUrl: "grpc://0.0.0.0:4546", networkId: "execution-id", transportSecurity: "private-network-only"
    },
    control: {
      id: "control-id", homeBinding: "owner-default", homeIdentity: { device: "1", inode: "2" },
      appServer: {
        controlContainerId: "control-id", execId: "app-server-exec", serverPid: 13,
        socketPath: "/codex-home/app-server-control/app-server-control.sock",
        socketIdentity: { device: "1", inode: "6" }, homeIdentity: { device: "1", inode: "2" },
        codeModeHostUrl: "http://codex-code-mode-host:4546", transportSecurity: "private-network-only"
      }
    },
    sessions: []
  };

  const reloaded = parseCodexSplitRuntimeRecord(JSON.parse(JSON.stringify(record)) as unknown);
  const endpoint = endpointFromRecord(reloaded);

  expect(endpoint).toMatchObject({
    endpointUrl: record.executor.endpointUrl,
    endpointHost: "codex-executor",
    endpointPort: 4545,
    security: "private-network-only",
    authenticationEvidence: "absent",
    credential: null,
    workspaceId: record.workspaceId,
    generation: record.generation,
    executionNetworkId: record.networks.execution.id
  });
});

test("rejects an incompatible persisted transport record before endpoint reconstruction", () => {
  const record = {
    version: 1,
    projectId: "018f0f00-0000-7000-8000-000000000001",
    workspaceId: "018f0f00-0000-7000-8000-000000000002",
    revisionId: "018f0f00-0000-7000-8000-000000000003",
    runtimePlanHash: `sha256-jcs-v1:${"a".repeat(64)}`,
    generation: 1,
    networks: {
      execution: {
        id: "execution-id", name: "devspace-codex-execution", role: "execution", internal: true, defaultRoute: false
      },
      controlEgress: {
        id: "egress-id", name: "devspace-codex-egress", role: "control-egress", internal: false, defaultRoute: true
      }
    },
    executor: {
      id: "executor-id", imageId: `sha256:${"b".repeat(64)}`,
      endpointUrl: "ws://codex-executor:4545", transportSecurity: "private-network-only",
      staleEndpoint: true
    },
    control: { id: "control-id", homeBinding: "owner-default" },
    sessions: []
  };

  expect(() => parseCodexSplitRuntimeRecord(record)).toThrow("codex-split-runtime-record");
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
    expect(evidence.sections).toEqual({ A: false, B: false, C: false, D: false, E: false, F: false, G: false, H: false });
    expect(evidence.readiness).toBe("BLOCKED/INCOMPLETE");
    expect(evidence.transportEvidence).toEqual({ execServer: "unproven", codeModeHost: "unproven" });
    expect(evidence.realModelProof).toBeNull();
    expect(evidence.operatorProof).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight mode stops before any operator or native TUI interaction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-codex-verifier-preflight-mode-"));
  try {
    const executablePath = path.join(root, "codex");
    await writeFile(executablePath, "#!/bin/sh\nprintf 'codex-cli 0.153.4\\n'\n", { mode: 0o700 });
    await chmod(executablePath, 0o700);
    const managed = new ManagedWorkspaces({
      projects: path.join(root, "projects"), workspaces: path.join(root, "workspaces"), state: path.join(root, "state")
    });
    const docker = new DockerEngineClient(path.join(root, "docker.sock"));
    class FailingRuntime extends CodexSplitRuntime {
      override ensure(_input: { readonly projectId: string; readonly workspaceId: string }): Promise<CodexSplitRuntimeRecord> {
        return Promise.reject(new Error("codex-split-test-preflight-mode"));
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

    const result = await runCodexSplitFeasibilityPreflight({
      configuration: parseCodexSplitVerifyEnvironment({ ...validEnvironment, DEVSPACE_CODEX_EXECUTABLE_PATH: executablePath }),
      services
    });

    expect(result.status).toBe("BLOCKED/INCOMPLETE");
    expect(result.evidence.incompleteReason).toBe("codex-split-test-preflight-mode");
    expect(result.evidence.readiness).toBe("BLOCKED/INCOMPLETE");
    expect(result.evidence.realModelProof).toBeNull();
    expect(result.evidence.operatorProof).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
