import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import {
  assertCodexExecServerReady,
  probeCodexExecServerReady,
  startCodexExecServer,
  stopCodexExecServer,
  type CodexExecServerHandle
} from "./exec-server.js";
import type { CodexProjectExecutorBinding } from "./project-executor.js";
import type { CodexSplitTransportBinding } from "./transport.js";
import { DockerEngineClient, type DockerExecInspection, type DockerProcessTable } from "../docker-runtime.js";

const executionNetwork = {
  role: "execution" as const, workspaceId: "018f0f00-0000-7000-8000-000000000002", generation: 1,
  id: "execution-id", name: "execution-network", controlAlias: "codex-control" as const,
  executorAlias: "codex-executor" as const, internal: true as const, defaultRoute: false as const, publishedPorts: [] as const
};

const executor = {
  containerId: "executor-id", containerName: "codex-executor", endpointHost: "codex-executor" as const,
  endpointPort: 4545, controlEgressAttached: false as const,
  policy: {
    artifact: { launcherPath: "/opt/devspace/codex-launcher/codex" },
    executionNetwork,
    workspaceId: executionNetwork.workspaceId, generation: 1, workingDirectory: "/workspace"
  }
} as unknown as CodexProjectExecutorBinding;

const transport: CodexSplitTransportBinding = {
  endpointUrl: "ws://codex-executor:4545", endpointHost: "codex-executor", endpointPort: 4545,
  security: "private-network-only", authenticationEvidence: "absent", credential: null,
  workspaceId: executionNetwork.workspaceId, generation: 1, executionNetworkId: executionNetwork.id
};

type InspectionOverrides = Omit<Partial<DockerExecInspection>, "Pid"> & { readonly Pid?: number | undefined };

function inspection(overrides: InspectionOverrides = {}): DockerExecInspection {
  return { ID: "server-exec", Running: true, ExitCode: null, ContainerID: "executor-id", Pid: 123, ...overrides } as DockerExecInspection;
}

function readinessOptions(deadlineMs = 5) {
  let currentTime = 0;
  return {
    deadlineMs,
    pollIntervalMs: 1,
    now: () => currentTime,
    sleep: (milliseconds: number) => { currentTime += milliseconds; return Promise.resolve(); }
  };
}

function startupOptions(deadlineMs = 5) {
  let currentTime = 0;
  return {
    deadlineMs,
    pollIntervalMs: 1,
    now: () => currentTime,
    sleep: (milliseconds: number) => { currentTime += milliseconds; return Promise.resolve(); }
  };
}

function dockerFixture(options: {
  readonly serverInspection?: DockerExecInspection;
  readonly serverInspections?: readonly DockerExecInspection[];
  readonly readinessInspection?: DockerExecInspection;
  readonly readinessInspections?: readonly DockerExecInspection[];
  readonly execIds?: readonly string[];
  readonly topProcessTables?: readonly DockerProcessTable[];
} = {}): { readonly docker: DockerEngineClient; readonly calls: unknown[]; readonly topArguments: string[] } {
  const calls: unknown[] = [];
  const topArguments: string[] = [];
  let execCount = 0;
  let serverInspectionCount = 0;
  let readinessInspectionCount = 0;
  let topProcessCount = 0;
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createExec(_containerId: string, input: unknown): Promise<string> {
      calls.push(input);
      execCount += 1;
      return Promise.resolve(options.execIds?.[execCount - 1] ?? (execCount === 1 ? "server-exec" : "ready-exec"));
    }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override inspectExec(execId: string): Promise<DockerExecInspection> {
      if (execId === "server-exec") {
        const scripted = options.serverInspections?.[Math.min(serverInspectionCount++, (options.serverInspections?.length ?? 1) - 1)];
        return Promise.resolve(scripted ?? options.serverInspection ?? inspection());
      }
      const scripted = options.readinessInspections?.[Math.min(readinessInspectionCount++, (options.readinessInspections?.length ?? 1) - 1)];
      return Promise.resolve(scripted ?? options.readinessInspection ?? inspection({ ID: execId, Running: false, ExitCode: 0, Pid: 0 }));
    }
    override topContainer(_containerId: string, psArgs: string): Promise<DockerProcessTable> {
      topArguments.push(psArgs);
      const scripted = options.topProcessTables?.[Math.min(topProcessCount++, (options.topProcessTables?.length ?? 1) - 1)];
      return Promise.resolve(scripted ?? { titles: ["PID", "ARGS"], processes: [["123", "codex exec-server"]] });
    }
    override stopContainer(id: string): Promise<void> { calls.push(id); return Promise.resolve(); }
  }();
  return { docker, calls, topArguments };
}

const VERIFIER_OTEL_ENDPOINT = "http://127.0.0.1:43180/v1/traces";
const VERIFIER_OTEL_OVERRIDE = 'otel.trace_exporter={ otlp-http = { endpoint = "http://127.0.0.1:43180/v1/traces", protocol = "json" } }';

test("starts the verified exec-server only inside the executor", async () => {
  const fixture = dockerFixture();
  const handle = await startCodexExecServer({ docker: fixture.docker, executor, transport });
  expect(handle).toMatchObject({ executorContainerId: "executor-id", execId: "server-exec", serverPid: 123 });
  expect(fixture.calls[0]).toEqual({
    command: ["/opt/devspace/codex-launcher/codex", "exec-server", "--listen", "ws://0.0.0.0:4545"],
    workingDirectory: "/workspace", environment: {}, attachStdin: false, tty: false
  });
});

test("configures verifier-only executor OTEL without native home, credentials, or control-egress", async () => {
  const fixture = dockerFixture();
  const handle = await startCodexExecServer({
    docker: fixture.docker, executor, transport, otelTraceExporterEndpoint: VERIFIER_OTEL_ENDPOINT
  });
  expect(handle).toMatchObject({ executorContainerId: "executor-id", execId: "server-exec", serverPid: 123 });
  expect(fixture.calls[0]).toEqual({
    command: [
      "/opt/devspace/codex-launcher/codex",
      "-c",
      VERIFIER_OTEL_OVERRIDE,
      "exec-server",
      "--listen",
      "ws://0.0.0.0:4545"
    ],
    workingDirectory: "/workspace",
    environment: {},
    attachStdin: false,
    tty: false
  });
  const environment = (fixture.calls[0] as { readonly environment: Readonly<Record<string, string>> }).environment;
  expect(environment).not.toHaveProperty("CODEX_HOME");
  expect(environment).not.toHaveProperty("HOME");
  expect(Object.keys(environment).some((name) => /^(?:CODEX_|OPENAI_).*(?:KEY|TOKEN)$/u.test(name))).toBe(false);
  expect(executor.controlEgressAttached).toBe(false);
});

test("rejects a verifier OTEL endpoint that is not executor-local loopback", async () => {
  await expect(startCodexExecServer({
    docker: dockerFixture().docker, executor, transport,
    otelTraceExporterEndpoint: "http://codex-control:43180/v1/traces"
  })).rejects.toThrow("codex-exec-server-otel-endpoint");
});

test("leaves non-verifier exec-server launch command unchanged when OTEL is omitted", async () => {
  const fixture = dockerFixture();
  await startCodexExecServer({ docker: fixture.docker, executor, transport });
  expect((fixture.calls[0] as { readonly command: readonly string[] }).command).toEqual([
    "/opt/devspace/codex-launcher/codex", "exec-server", "--listen", "ws://0.0.0.0:4545"
  ]);
});

test("requires an executing server with a stable PID and rejects a stale process", async () => {
  const fixture = dockerFixture({ serverInspection: inspection({ Pid: 0 }) });
  await expect(startCodexExecServer({ docker: fixture.docker, executor, transport, startup: startupOptions(2) }))
    .rejects.toThrow("codex-exec-server-startup-timeout");
});

test("waits through a transient pre-running server state before accepting it", async () => {
  const fixture = dockerFixture({ serverInspections: [
    inspection({ Running: false, ExitCode: null, Pid: undefined }),
    inspection()
  ] });
  await expect(startCodexExecServer({ docker: fixture.docker, executor, transport, startup: startupOptions() }))
    .resolves.toMatchObject({ execId: "server-exec", serverPid: 123 });
});

test("waits through a running exec that has not received a stable PID", async () => {
  const fixture = dockerFixture({ serverInspections: [
    inspection({ Running: true, ExitCode: null, Pid: undefined }),
    inspection()
  ] });
  await expect(startCodexExecServer({ docker: fixture.docker, executor, transport, startup: startupOptions() }))
    .resolves.toMatchObject({ execId: "server-exec", serverPid: 123 });
});

test("classifies a server that exits before reaching a running state", async () => {
  const fixture = dockerFixture({ serverInspection: inspection({ Running: false, ExitCode: 17, Pid: undefined }) });
  await expect(startCodexExecServer({ docker: fixture.docker, executor, transport, startup: startupOptions() }))
    .rejects.toMatchObject({ message: "codex-exec-server-exited-before-ready", exitCode: 17 });
});

test("rejects a malformed server exec identity without treating it as a transition", async () => {
  const fixture = dockerFixture({ serverInspection: inspection({ ID: "unexpected-exec" }) });
  await expect(startCodexExecServer({ docker: fixture.docker, executor, transport, startup: startupOptions() }))
    .rejects.toThrow("codex-exec-server-identity");
});

test("bounds a server startup transition that never reaches running", async () => {
  const fixture = dockerFixture({ serverInspection: inspection({ Running: false, ExitCode: null, Pid: undefined }) });
  await expect(startCodexExecServer({ docker: fixture.docker, executor, transport, startup: startupOptions(2) }))
    .rejects.toThrow("codex-exec-server-startup-timeout");
});

test("checks the executor-local readyz endpoint and fails on a non-ready probe", async () => {
  const fixture = dockerFixture({ readinessInspection: inspection({ ID: "ready-exec", Running: false, ExitCode: 7, Pid: 0 }) });
  const handle = await startCodexExecServer({ docker: fixture.docker, executor, transport });
  const request = { docker: fixture.docker, handle, readiness: readinessOptions() };
  await expect(assertCodexExecServerReady(request)).rejects.toThrow("codex-exec-server-not-ready");
  const readinessCall = fixture.calls[1] as { readonly command: readonly string[]; readonly workingDirectory: string };
  expect(readinessCall).toMatchObject({ workingDirectory: "/" });
  expect(readinessCall.command[0]).toBe("/bin/sh");
  expect(readinessCall.command[2]).toContain("/readyz");
});

test("waits for a short-lived readiness probe to finish before reading its exit code", async () => {
  const fixture = dockerFixture({ readinessInspections: [
    inspection({ ID: "ready-exec", Running: true, ExitCode: null, Pid: 0 }),
    inspection({ ID: "ready-exec", Running: false, ExitCode: 0, Pid: 0 })
  ] });
  const handle = await startCodexExecServer({ docker: fixture.docker, executor, transport });
  const request = { docker: fixture.docker, handle, readiness: readinessOptions() };
  await expect(assertCodexExecServerReady(request)).resolves.toBeUndefined();
});

test("retries a completed nonzero readiness probe while the server remains alive", async () => {
  const fixture = dockerFixture({ readinessInspections: [
    inspection({ ID: "ready-exec", Running: false, ExitCode: 7, Pid: 0 }),
    inspection({ ID: "ready-exec", Running: false, ExitCode: 0, Pid: 0 })
  ] });
  const handle = await startCodexExecServer({ docker: fixture.docker, executor, transport });
  const request = { docker: fixture.docker, handle, readiness: readinessOptions() };
  await expect(assertCodexExecServerReady(request)).resolves.toBeUndefined();
  expect(fixture.calls.filter((call) => typeof call === "object")).toHaveLength(3);
});

test("fails with a server-process error when the server exits while a probe is pending", async () => {
  const fixture = dockerFixture({
    serverInspections: [inspection(), inspection({ Running: false, ExitCode: 1 })],
    readinessInspections: [inspection({ ID: "ready-exec", Running: true, ExitCode: null, Pid: 0 })]
  });
  const handle = await startCodexExecServer({ docker: fixture.docker, executor, transport });
  const request = { docker: fixture.docker, handle, readiness: readinessOptions() };
  await expect(assertCodexExecServerReady(request)).rejects.toThrow("codex-exec-server-process");
});

test("returns not-ready at the bounded deadline while the server remains alive", async () => {
  const fixture = dockerFixture({ readinessInspection: inspection({ ID: "ready-exec", Running: false, ExitCode: 7, Pid: 0 }) });
  const handle = await startCodexExecServer({ docker: fixture.docker, executor, transport });
  const request = { docker: fixture.docker, handle, readiness: readinessOptions(3) };
  await expect(assertCodexExecServerReady(request)).rejects.toThrow("codex-exec-server-not-ready");
  expect(fixture.calls.filter((call) => typeof call === "object")).toHaveLength(4);
});

test("treats malformed readiness probe identity as a hard error without retrying", async () => {
  const fixture = dockerFixture({ readinessInspection: inspection({ ID: "unexpected-exec", Running: false, ExitCode: 0, Pid: 0 }) });
  const handle = await startCodexExecServer({ docker: fixture.docker, executor, transport });
  const request = { docker: fixture.docker, handle, readiness: readinessOptions() };
  await expect(assertCodexExecServerReady(request)).rejects.toThrow("codex-exec-server-probe");
  expect(fixture.calls.filter((call) => typeof call === "object")).toHaveLength(2);
});

test("rejects reattach of an exec-server that lacks the required verifier OTEL identity", async () => {
  const fixture = dockerFixture({ execIds: ["ready-exec"] });
  await expect(probeCodexExecServerReady({
    docker: fixture.docker, executor, transport, readiness: readinessOptions(),
    otelTraceExporterEndpoint: VERIFIER_OTEL_ENDPOINT
  })).rejects.toThrow("codex-exec-server-telemetry-identity");
});

test("reattaches an exec-server whose process args carry the verifier OTEL identity", async () => {
  const fixture = dockerFixture({
    execIds: ["ready-exec"],
    topProcessTables: [
      { titles: ["PID", "ARGS"], processes: [["123", `codex -c ${VERIFIER_OTEL_OVERRIDE} exec-server`]] },
      { titles: ["PID", "ARGS"], processes: [["123", `codex -c ${VERIFIER_OTEL_OVERRIDE} exec-server`]] }
    ]
  });
  await expect(probeCodexExecServerReady({
    docker: fixture.docker, executor, transport, readiness: readinessOptions(),
    otelTraceExporterEndpoint: VERIFIER_OTEL_ENDPOINT
  })).resolves.toBe(123);
});

test("reattaches with the same bounded readiness semantics", async () => {
  const fixture = dockerFixture({
    execIds: ["ready-exec"],
    readinessInspections: [
      inspection({ ID: "ready-exec", Running: false, ExitCode: 7, Pid: 0 }),
      inspection({ ID: "ready-exec", Running: false, ExitCode: 0, Pid: 0 })
    ],
    topProcessTables: [
      { titles: ["PID", "ARGS"], processes: [["123", "codex exec-server"]] },
      { titles: ["PID", "ARGS"], processes: [["123", "codex exec-server"]] }
    ]
  });
  const request = { docker: fixture.docker, executor, transport, readiness: readinessOptions() };
  await expect(probeCodexExecServerReady(request)).resolves.toBe(123);
});

test("uses Docker's explicit ps output format for process observations", async () => {
  const fixture = dockerFixture({ execIds: ["ready-exec"] });
  await expect(probeCodexExecServerReady({ docker: fixture.docker, executor, transport, readiness: readinessOptions() }))
    .resolves.toBe(123);
  expect(fixture.topArguments).toEqual(["-o pid,args", "-o pid,args", "-o pid,args", "-o pid,args"]);
});

test("rejects an endpoint with the wrong executor identity or control-egress network", async () => {
  await expect(startCodexExecServer({
    docker: dockerFixture().docker, executor,
    transport: { ...transport, endpointUrl: "ws://wrong-host:4545" }
  })).rejects.toThrow("codex-exec-server-endpoint");
  await expect(startCodexExecServer({
    docker: dockerFixture().docker, executor,
    transport: { ...transport, executionNetworkId: "control-egress-id" }
  })).rejects.toThrow("codex-exec-server-network");
});

test("stops only the executor container that owns the server", async () => {
  const fixture = dockerFixture();
  const handle: CodexExecServerHandle = { executorContainerId: "executor-id", execId: "server-exec", endpoint: transport, serverPid: 123 };
  await stopCodexExecServer({ docker: fixture.docker, handle });
  expect(fixture.calls).toEqual(["executor-id"]);
});
