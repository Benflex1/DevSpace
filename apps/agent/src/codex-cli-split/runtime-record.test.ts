import { expect, test } from "vitest";
import {
  assertCodexSplitHomeIdentity,
  assertCodexSplitSessionConcurrency,
  codexSplitRuntimeRecordSchema,
  parseCodexSplitRuntimeRecord,
  parseCodexSplitRuntimeResourceReference,
  type CodexSplitRuntimeRecord
} from "./runtime-record.js";

const sessionId = "018f0f00-0000-7000-8000-000000000021";
const secondSessionId = "018f0f00-0000-7000-8000-000000000022";
const record: CodexSplitRuntimeRecord = {
  version: 2,
  projectId: "018f0f00-0000-7000-8000-000000000001",
  workspaceId: "018f0f00-0000-7000-8000-000000000002",
  revisionId: "018f0f00-0000-7000-8000-000000000003",
  runtimePlanHash: `sha256-jcs-v1:${"a".repeat(64)}`,
  generation: 1,
  networks: {
    execution: { id: "execution-id", name: "devspace-codex-execution", role: "execution", internal: true, defaultRoute: false },
    controlEgress: { id: "egress-id", name: "devspace-codex-egress", role: "control-egress", internal: false, defaultRoute: true }
  },
  artifact: {
    packageVersion: "0.153.4",
    closureDigest: "d".repeat(64),
    nativeCliPath: "/opt/devspace/codex/bin/codex",
    execServerCapability: "codex-0.153.4-exec-server",
    appServerCapability: "codex-0.153.4-app-server",
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

test("parses a strict opaque split runtime record and rejects secret/path fields", () => {
  expect(parseCodexSplitRuntimeRecord(record)).toEqual(record);
  expect(() => parseCodexSplitRuntimeRecord({ ...record, nativeHomePath: "/private/home" })).toThrow("runtime-record");
  expect(() => parseCodexSplitRuntimeRecord({ ...record, executor: { ...record.executor, token: "secret" } })).toThrow("runtime-record");
  expect(() => parseCodexSplitRuntimeRecord({ ...record, networks: { ...record.networks, execution: { ...record.networks.execution, defaultRoute: true } } }))
    .toThrow("runtime-record");
  expect(codexSplitRuntimeRecordSchema.parse(record)).toEqual(record);
});

test("accepts distinct concurrent sessions but rejects a duplicate live native ID", () => {
  const withSessions = parseCodexSplitRuntimeRecord({
    ...record,
    sessions: [
      {
        nativeSessionId: sessionId, controlContainerId: "control-id", controlExecId: "exec-1",
        homeIdentity: { device: "1", inode: "2" }, state: "live", startedAt: "2026-09-16T10:00:00.000Z", stoppedAt: null
      },
      {
        nativeSessionId: secondSessionId, controlContainerId: "control-id", controlExecId: "exec-2",
        homeIdentity: { device: "1", inode: "2" }, state: "live", startedAt: "2026-09-16T10:01:00.000Z", stoppedAt: null
      }
    ]
  });
  expect(() => assertCodexSplitSessionConcurrency(withSessions, "018f0f00-0000-7000-8000-000000000023")).not.toThrow();
  expect(() => assertCodexSplitSessionConcurrency(withSessions, sessionId)).toThrow("session-live");
  expect(() => parseCodexSplitRuntimeRecord({
    ...record,
    sessions: [withSessions.sessions[0], { ...withSessions.sessions[0], controlExecId: "exec-3" }]
  })).toThrow("session-live");
});

test("fails closed when the persisted native-home identity changes", () => {
  expect(() => assertCodexSplitHomeIdentity({ device: "1", inode: "2" }, { device: "1", inode: "2" })).not.toThrow();
  expect(() => assertCodexSplitHomeIdentity({ device: "1", inode: "2" }, { device: "1", inode: "3" })).toThrow("home-identity");
  expect(() => assertCodexSplitHomeIdentity({ device: "1", inode: "2" }, { device: "2", inode: "2" })).toThrow("home-identity");
});

test("parses only validated split resource identity for an incompatible record", () => {
  expect(parseCodexSplitRuntimeResourceReference({
    version: 2,
    projectId: record.projectId,
    workspaceId: record.workspaceId,
    generation: record.generation,
    networks: record.networks,
    executor: { id: record.executor.id },
    control: { id: record.control.id },
    unsupportedNewField: "ignored for cleanup identity only"
  })).toMatchObject({
    version: 2,
    projectId: record.projectId,
    workspaceId: record.workspaceId,
    generation: record.generation,
    executor: { id: record.executor.id },
    control: { id: record.control.id }
  });
  expect(() => parseCodexSplitRuntimeResourceReference({ ...record, control: {} })).toThrow("codex-split-runtime-reference");
});

test("parses the current split topology with both executor services and app-server provenance", () => {
  expect(parseCodexSplitRuntimeRecord(record)).toEqual(record);
  expect(() => parseCodexSplitRuntimeRecord({ ...record, unsupported: true })).toThrow("codex-split-runtime-record");
  expect(() => parseCodexSplitRuntimeRecord({ ...record, codeModeHost: { ...record.codeModeHost, networkId: "foreign" } }))
    .toThrow("codex-split-runtime-record");
});

test("rejects a legacy bare-TUI record instead of accepting partial split state", () => {
  expect(() => parseCodexSplitRuntimeRecord({
    version: 1,
    projectId: record.projectId,
    workspaceId: record.workspaceId,
    revisionId: record.revisionId,
    runtimePlanHash: record.runtimePlanHash,
    generation: record.generation,
    networks: record.networks,
    executor: {
      id: record.executor.id,
      imageId: record.executor.imageId,
      endpointUrl: record.executor.endpointUrl,
      transportSecurity: record.executor.transportSecurity
    },
    control: { id: record.control.id, homeBinding: record.control.homeBinding },
    sessions: []
  })).toThrow("codex-split-runtime-record");
});
