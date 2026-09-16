import { expect, test } from "vitest";
import {
  assertCodexSplitHomeIdentity,
  assertCodexSplitSessionConcurrency,
  codexSplitRuntimeRecordSchema,
  parseCodexSplitRuntimeRecord,
  type CodexSplitRuntimeRecord
} from "./runtime-record.js";

const sessionId = "018f0f00-0000-7000-8000-000000000021";
const secondSessionId = "018f0f00-0000-7000-8000-000000000022";
const record: CodexSplitRuntimeRecord = {
  version: 1,
  projectId: "018f0f00-0000-7000-8000-000000000001",
  workspaceId: "018f0f00-0000-7000-8000-000000000002",
  revisionId: "018f0f00-0000-7000-8000-000000000003",
  runtimePlanHash: `sha256-jcs-v1:${"a".repeat(64)}`,
  generation: 1,
  networks: {
    execution: { id: "execution-id", name: "devspace-codex-execution", role: "execution", internal: true, defaultRoute: false },
    controlEgress: { id: "egress-id", name: "devspace-codex-egress", role: "control-egress", internal: false, defaultRoute: true }
  },
  executor: { id: "executor-id", imageId: `sha256:${"b".repeat(64)}`, endpointUrl: "ws://codex-executor:4545", transportSecurity: "private-network-only" },
  control: { id: "control-id", homeBinding: "owner-default" },
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
