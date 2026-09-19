import path from "node:path";
import { v7 as uuidv7 } from "uuid";
import {
  DockerEngineClient,
  type DockerContainerInspection,
  type DockerProcessTable
} from "../src/docker-runtime.js";
import { ManagedWorkspaces, type ManagedWorkspaceRoots } from "../src/managed-workspaces.js";
import { CodexSplitRuntime } from "../src/codex-cli-split/split-runtime.js";
import {
  ensureNativeCodexHome,
  nativeCodexHomePath
} from "../src/codex-cli-split/native-home.js";
import {
  assertCodexNativeAppServerProbeSocket,
  buildCodexNativeAppServerProbeSocket,
  createCodexNativeAppServerProbeConnection,
  runCodexNativeAppServerModelProbe,
  type CodexNativeAppServerProbeModel
} from "./codex-native-app-server-probe.js";
import {
  formatCodexSplitDiagnostic,
  parseCodexSplitVerifyEnvironment
} from "../src/codex-cli-split/feasibility-verifier.js";
import { probeAdmittedCodexVersion } from "../src/codex-cli-split/compatibility.js";
import { lstatIdentity } from "../src/private-state.js";
import {
  CODEX_NATIVE_OTEL_COLLECTOR_MARKER,
  CODEX_NATIVE_OTEL_TRACE_EXPORTER_ENDPOINT,
  drainCodexNativeOtelObservations,
  startCodexNativeOtelCollector,
  type CodexNativeOtelCollectorHandle
} from "./codex-native-otel-collector.js";
import {
  mergeCodexNativeOtelSpanSources,
  projectCodexNativeRemoteCodeModeEvidence,
  type CodexNativeOtelSpanObservation
} from "./codex-native-remote-code-mode-evidence.js";

const OPERATION = "pwd" as const;
const MAX_DIAGNOSTIC_REASON_LENGTH = 128;
const INFRASTRUCTURE_BLOCKED = "BLOCKED/INCOMPLETE" as const;
const CORRELATION_TIMEOUT_MS = 15_000;
const CORRELATION_POLL_MS = 100;

function requestedModel(): CodexNativeAppServerProbeModel {
  const model = process.env.DEVSPACE_CODEX_VERIFY_MODEL;
  if (model !== "gpt-5.6-luna" && model !== "gpt-6-astra") throw new Error("codex-model-probe-model");
  return model;
}

function boundedReason(error: unknown): string {
  const value = error instanceof Error ? error.message : "codex-model-probe-unexpected-failure";
  if (/^[a-z0-9][a-z0-9./_-]*$/u.test(value) && value.length <= MAX_DIAGNOSTIC_REASON_LENGTH) return value;
  return "codex-model-probe-unexpected-failure";
}

function commandColumn(table: DockerProcessTable): number {
  const index = table.titles.findIndex((title) => /^(?:COMMAND|CMD)$/iu.test(title));
  return index >= 0 ? index : table.titles.length - 1;
}

function isInfrastructureCommand(command: string): boolean {
  return /(?:^|[/ ])(?:sh|sleep|pause|tini)(?:$| )/iu.test(command)
    || command.includes("/opt/devspace/codex-launcher/codex app-server")
    || command.includes("/opt/devspace/codex/bin/codex-code-mode-host")
    || command.includes("/opt/devspace/codex/bin/codex exec-server")
    || (command.includes("node -e") && command.trimEnd().endsWith(` ${CODEX_NATIVE_OTEL_COLLECTOR_MARKER}`));
}

const EXECUTOR_CREDENTIAL_ENVIRONMENT_NAMES = new Set([
  "CODEX_HOME", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_AUTH_TOKEN", "CODEX_REFRESH_TOKEN",
  "OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "OPENAI_AUTH_TOKEN", "OPENAI_REFRESH_TOKEN"
]);

function hasExecutorCredentials(environment: readonly string[] | null | undefined): boolean {
  return (environment ?? []).some((entry) => {
    const separator = entry.indexOf("=");
    return separator > 0 && EXECUTOR_CREDENTIAL_ENVIRONMENT_NAMES.has(entry.slice(0, separator));
  });
}

function projectProcessCount(table: DockerProcessTable): number {
  const column = commandColumn(table);
  return table.processes.reduce((count, row) => {
    const command = row[column];
    return command !== undefined && !isInfrastructureCommand(command) ? count + 1 : count;
  }, 0);
}

function inspectResourceProcessState(input: {
  readonly container: DockerContainerInspection;
  readonly table: DockerProcessTable;
  readonly appServerRunning?: boolean;
}): number {
  if (!input.container.State.Running) throw new Error("codex-model-probe-container-not-running");
  if (input.appServerRunning === false) throw new Error("codex-model-probe-app-server-process");
  return projectProcessCount(input.table);
}

function boundedSpanAttribute(span: CodexNativeOtelSpanObservation, name: string): string {
  const value = span.attributes[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 256
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new Error("codex-model-probe-otel-correlation");
  }
  return value;
}

function spanByName(spans: readonly CodexNativeOtelSpanObservation[], name: CodexNativeOtelSpanObservation["name"]): CodexNativeOtelSpanObservation {
  const matches = spans.filter((span) => span.name === name);
  if (matches.length !== 1) throw new Error("codex-model-probe-otel-correlation");
  return matches[0]!;
}

async function observeRemoteCodeModeEvidence(input: {
  readonly controlCollector: CodexNativeOtelCollectorHandle;
  readonly executorCollector: CodexNativeOtelCollectorHandle;
  readonly model: CodexNativeAppServerProbeModel;
  readonly threadId: string;
  readonly turnId: string;
  readonly selectedToolMode: "CodeModeOnly" | null;
  readonly controlProjectProcessCount: number;
  readonly executorProjectProcessCount: number;
  readonly codeModeHostContainerId: string;
  readonly execServerContainerId: string;
}): Promise<unknown> {
  const toolModeEvidence = input.selectedToolMode === "CodeModeOnly"
    ? { kind: "protocol" as const, value: "CodeModeOnly" as const }
    : {
      kind: "pinned-model-metadata-plus-runtime" as const,
      model: input.model,
      remoteCodeModeObserved: true as const
    };
  const control: CodexNativeOtelSpanObservation[] = [];
  const executor: CodexNativeOtelSpanObservation[] = [];
  let lastReason = "codex-model-probe-remote-code-mode-unobserved";
  let evidence: unknown;
  await drainCodexNativeOtelObservations({
    takeObservations: () => {
      control.push(...input.controlCollector.takeObservations());
      executor.push(...input.executorCollector.takeObservations());
      return [...control, ...executor];
    },
    isComplete: () => {
      const merged = mergeCodexNativeOtelSpanSources({ control, executor });
      if (!merged.ok) {
        lastReason = merged.reason;
        return false;
      }
      try {
        const execute = spanByName(merged.spans, "code_mode.grpc.execute");
        const callback = spanByName(merged.spans, "code_mode.grpc.callback");
        const process = spanByName(merged.spans, "codex.exec_server.process");
        const projection = projectCodexNativeRemoteCodeModeEvidence({
          model: input.model,
          toolModeEvidence,
          threadId: input.threadId,
          turnId: input.turnId,
          codeModeHostContainerId: input.codeModeHostContainerId,
          execServerContainerId: input.execServerContainerId,
          codeModeTiming: {
            threadId: input.threadId,
            turnId: input.turnId,
            callId: boundedSpanAttribute(execute, "call_id"),
            cellId: boundedSpanAttribute(callback, "cell.id"),
            toolName: "exec",
            cwd: "/workspace",
            hostCompleted: true,
            aborted: false
          },
          spans: merged.spans,
          execProcess: {
            executorContainerId: input.execServerContainerId,
            cwd: "/workspace",
            exitCode: boundedSpanAttribute(process, "result") === "success" ? 0 : 1,
            closed: true,
            failed: boundedSpanAttribute(process, "result") !== "success"
          },
          turnCompleted: true,
          controlProjectProcessCount: input.controlProjectProcessCount,
          executorProjectProcessCount: input.executorProjectProcessCount,
          executorHasNativeHome: false,
          executorHasCredentials: false
        });
        if (projection.readiness === "MODEL_CORRELATION_OBSERVER_READY") {
          evidence = projection.evidence;
          return true;
        }
        lastReason = projection.reason;
        return false;
      } catch (error) {
        lastReason = error instanceof Error ? error.message : "codex-model-probe-otel-correlation";
        return false;
      }
    },
    deadlineMs: CORRELATION_TIMEOUT_MS,
    pollIntervalMs: CORRELATION_POLL_MS
  });
  if (evidence === undefined) throw new Error(lastReason);
  return evidence;
}

async function main(): Promise<void> {
  const runId = uuidv7();
  let configuration: ReturnType<typeof parseCodexSplitVerifyEnvironment>;
  try {
    configuration = parseCodexSplitVerifyEnvironment(process.env);
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: INFRASTRUCTURE_BLOCKED, runId, reason: boundedReason(error) }) + "\n");
    process.exitCode = 1;
    return;
  }

  const docker = new DockerEngineClient(configuration.dockerSocketPath);
  let runtime: CodexSplitRuntime | null = null;
  let controlCollector: CodexNativeOtelCollectorHandle | null = null;
  let executorCollector: CodexNativeOtelCollectorHandle | null = null;
  let ensured = false;
  try {
    await docker.assertRootlessAvailable();
    const admitted = await probeAdmittedCodexVersion({ executablePath: configuration.codexExecutablePath });
    if (admitted.version !== "0.153.4") throw new Error("codex-model-probe-version");
    const roots: ManagedWorkspaceRoots = {
      projects: path.join(configuration.managedRoot, "projects"),
      workspaces: path.join(configuration.managedRoot, "workspaces"),
      state: path.join(configuration.managedRoot, "state")
    };
    const managed = new ManagedWorkspaces(roots);
    await managed.initialize();
    runtime = new CodexSplitRuntime({
      managed,
      docker,
      stateRoot: roots.state,
      controlImageReference: configuration.controlImageReference,
      codexExecutablePath: configuration.codexExecutablePath,
      otelTraceExporterEndpoint: CODEX_NATIVE_OTEL_TRACE_EXPORTER_ENDPOINT
    });
    const record = await runtime.ensure({ projectId: configuration.projectId, workspaceId: configuration.workspaceId });
    ensured = true;
    controlCollector = await startCodexNativeOtelCollector({ docker, containerId: record.control.id });
    executorCollector = await startCodexNativeOtelCollector({ docker, containerId: record.executor.id });
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) throw new Error("codex-model-probe-agent-owner");
    const home = await ensureNativeCodexHome({
      homePath: nativeCodexHomePath(roots.state),
      ownerUid: uid,
      ownerGid: gid
    });
    const socket = buildCodexNativeAppServerProbeSocket(home);
    const model = requestedModel();
    const currentSocket = await lstatIdentity(socket.agentSocketPath);
    if (currentSocket === null) throw new Error("codex-model-probe-socket-missing");
    assertCodexNativeAppServerProbeSocket({
      home,
      socket,
      expectedHomeIdentity: home.identity,
      expectedSocketIdentity: currentSocket.identity
    });
    const controlInspection = await docker.inspectContainer(record.control.id);
    const executorInspection = await docker.inspectContainer(record.executor.id);
    const controlTable = await docker.topContainer(record.control.id, "aux");
    const controlAppServer = await docker.inspectExec(record.control.appServer.execId);
    const executorExecServer = await docker.inspectExec(record.execServer.execId);
    const executorCodeModeHost = await docker.inspectExec(record.codeModeHost.execId);
    const executorHasNativeHome = executorInspection.Mounts.some((mount) => mount.Destination === home.mountTarget)
      || (executorInspection.Config.Env ?? []).some((entry) => entry.startsWith("CODEX_HOME=") || entry.startsWith("HOME=/codex-home"));
    if (executorHasNativeHome) throw new Error("codex-model-probe-executor-home");
    if (hasExecutorCredentials(executorInspection.Config.Env)) throw new Error("codex-model-probe-executor-credentials");
    const initialControlProjectProcesses = inspectResourceProcessState({
      container: controlInspection,
      table: controlTable,
      appServerRunning: controlAppServer.Running && controlAppServer.ExitCode === null
    });
    if (initialControlProjectProcesses !== 0) throw new Error("codex-model-probe-control-project-process");
    if (!executorInspection.State.Running || !executorExecServer.Running || executorExecServer.ExitCode !== null
      || !executorCodeModeHost.Running || executorCodeModeHost.ExitCode !== null) {
      throw new Error("codex-model-probe-executor-service");
    }
    const evidence = await runCodexNativeAppServerModelProbe({
      socket,
      model,
      logicalCwd: "/workspace",
      operation: OPERATION,
      timeoutMs: 120_000
    }, {
      connect: (socketPath) => createCodexNativeAppServerProbeConnection(socketPath),
      inspectControl: async () => {
        const [container, table, appServer] = await Promise.all([
          docker.inspectContainer(record.control.id),
          docker.topContainer(record.control.id, "aux"),
          docker.inspectExec(record.control.appServer.execId)
        ]);
        return {
          projectProcessCount: inspectResourceProcessState({
            container,
            table,
            appServerRunning: appServer.Running && appServer.ExitCode === null
          }),
          appServerProcessCount: appServer.Running && appServer.ExitCode === null ? 1 : 0
        };
      },
      inspectExecutor: async () => {
        const [container, table, execServer, codeModeHost] = await Promise.all([
          docker.inspectContainer(record.executor.id),
          docker.topContainer(record.executor.id, "aux"),
          docker.inspectExec(record.execServer.execId),
          docker.inspectExec(record.codeModeHost.execId)
        ]);
        const hasHome = container.Mounts.some((mount) => mount.Destination === home.mountTarget)
          || (container.Config.Env ?? []).some((entry) => entry.startsWith("CODEX_HOME=") || entry.startsWith("HOME=/codex-home"));
        if (hasHome) throw new Error("codex-model-probe-executor-home");
        if (hasExecutorCredentials(container.Config.Env)) throw new Error("codex-model-probe-executor-credentials");
        return {
          projectProcessCount: inspectResourceProcessState({ container, table }),
          codeModeHostProcessCount: codeModeHost.Running && codeModeHost.ExitCode === null ? 1 : 0,
          execServerProcessCount: execServer.Running && execServer.ExitCode === null ? 1 : 0,
          hasNativeHome: false as const,
          hasCredentials: false as const,
          codeModeHostContainerId: record.codeModeHost.executorContainerId,
          execServerContainerId: record.execServer.executorContainerId
        };
      },
      observeRemoteCodeModeEvidence: (observation) => observeRemoteCodeModeEvidence({
        controlCollector: controlCollector!,
        executorCollector: executorCollector!,
        ...observation
      }),
      now: Date.now,
      sleep: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
    });
    process.stdout.write(`${JSON.stringify({
      status: "MODEL_REMOTE_COMPATIBLE",
      runId,
      model: evidence.model,
      toolModeEvidence: evidence.toolModeEvidence,
      codeModeProvider: evidence.codeModeProvider,
      codeModeHostContainerId: evidence.codeModeHostContainerId,
      execServerContainerId: evidence.execServerContainerId,
      logicalCwd: evidence.logicalCwd,
      controlProjectProcessCount: evidence.controlProjectProcessCount,
      executorProjectProcessCount: evidence.executorProjectProcessCount,
      codeModeHostProcessObserved: evidence.codeModeHostProcessObserved,
      execServerProcessObserved: evidence.execServerProcessObserved,
      nestedProjectExecObserved: evidence.nestedProjectExecObserved,
      operationCompleted: evidence.operationCompleted,
      executorHasNativeHome: evidence.executorHasNativeHome,
      executorHasCredentials: evidence.executorHasCredentials,
      correlationEvidence: evidence.correlationEvidence,
      approval: evidence.approval,
      transportSecurity: {
        execServer: record.execServer.transportSecurity,
        codeModeHost: record.codeModeHost.transportSecurity
      }
    })}\n`);
  } catch (error) {
    const reason = boundedReason(error);
    process.stdout.write(JSON.stringify({
      status: INFRASTRUCTURE_BLOCKED,
      runId,
      reason,
      approval: reason === "approval-required-for-model-compatibility-probe" ? "required-stop" : "not-requested"
    }) + "\n");
    process.exitCode = 1;
  } finally {
    controlCollector?.close();
    executorCollector?.close();
    if (ensured && runtime !== null) {
      await runtime.stop({ projectId: configuration.projectId, workspaceId: configuration.workspaceId }).catch((error: unknown) => {
        process.stderr.write(`${JSON.stringify(formatCodexSplitDiagnostic("cleanup", error, "verifier"))}\n`);
        process.exitCode = 1;
      });
    }
  }
}

void main().catch((error: unknown) => {
  process.stdout.write(JSON.stringify({ status: INFRASTRUCTURE_BLOCKED, reason: boundedReason(error) }) + "\n");
  process.exitCode = 1;
});
