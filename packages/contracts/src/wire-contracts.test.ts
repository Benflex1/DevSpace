import { describe, expect, test } from "vitest";
import {
  agentApiV1EndpointByOperation,
  PROJECT_OPTIONS_REVISION_MAX_BYTES,
  canonicalJsonObjectTextSchema,
  configurationRevisionDataSchema,
  createWorkspaceDataSchema,
  gitBranchNameSchema,
  mutationRequestHeadersSchema,
  processInspectionDataSchema,
  projectOptionsRevisionHashSchema,
  remoteRepositoryUrlSchema,
  resumeAiSessionDataSchema,
  startAiSessionDataSchema,
  utcTimestampMsSchema,
  uuidV7Schema
} from "./index.js";

const id = "018f1f34-7abc-7def-8abc-0123456789ab";
const id2 = "018f1f34-7abc-7def-9abc-0123456789ac";
const timestamp = "2026-07-15T12:34:56.789Z";
const hash = `sha256-jcs-v1:${"a".repeat(64)}`;

describe("canonical Agent wire primitives", () => {
  test("accepts only canonical lowercase UUIDv7", () => {
    expect(uuidV7Schema.safeParse(id).success).toBe(true);
    expect(uuidV7Schema.safeParse("018f1f34-7abc-4def-8abc-0123456789ab").success).toBe(false);
    expect(uuidV7Schema.safeParse(id.toUpperCase()).success).toBe(false);
    expect(uuidV7Schema.safeParse("not-a-uuid").success).toBe(false);
  });

  test("accepts only real exact UTC millisecond timestamps", () => {
    expect(utcTimestampMsSchema.safeParse(timestamp).success).toBe(true);
    expect(utcTimestampMsSchema.safeParse("2026-02-30T12:34:56.789Z").success).toBe(false);
    expect(utcTimestampMsSchema.safeParse("2026-07-15T12:34:56Z").success).toBe(false);
    expect(utcTimestampMsSchema.safeParse("2026-07-15T12:34:56.789+00:00").success).toBe(false);
  });

  test("validates revision hashes and canonical object text without hashing", () => {
    expect(projectOptionsRevisionHashSchema.safeParse(hash).success).toBe(true);
    expect(projectOptionsRevisionHashSchema.safeParse(`sha256-jcs-v1:${"A".repeat(64)}`).success).toBe(false);
    expect(canonicalJsonObjectTextSchema.safeParse('{"a":1,"b":2}').success).toBe(true);
    expect(canonicalJsonObjectTextSchema.safeParse('{"b":2,"a":1}').success).toBe(false);
    expect(canonicalJsonObjectTextSchema.safeParse("[]").success).toBe(false);
    expect(canonicalJsonObjectTextSchema.safeParse('{"value":"\\ud800"}').success).toBe(false);
  });

  test("enforces the exact canonical Project Options UTF-8 transfer boundary", () => {
    const framingBytes = Buffer.byteLength('{"value":""}', "utf8");
    const payloadBytes = PROJECT_OPTIONS_REVISION_MAX_BYTES - framingBytes;
    const atLimit = `{"value":"${"é".repeat(payloadBytes / 2)}"}`;
    const overLimit = `{"value":"${"é".repeat(payloadBytes / 2)}a"}`;
    expect(atLimit.length).toBeLessThan(PROJECT_OPTIONS_REVISION_MAX_BYTES);
    expect(Buffer.byteLength(atLimit, "utf8")).toBe(2_097_152);
    expect(Buffer.byteLength(overLimit, "utf8")).toBe(2_097_153);
    expect(canonicalJsonObjectTextSchema.safeParse(atLimit).success).toBe(true);
    expect(canonicalJsonObjectTextSchema.safeParse(overLimit).success).toBe(false);
  });

  test("contracts consume the domain branch authority", () => {
    expect(gitBranchNameSchema.safeParse("feature/agent-api").success).toBe(true);
    expect(gitBranchNameSchema.safeParse("feature/.hidden").success).toBe(false);
    expect(gitBranchNameSchema.safeParse("feature/main.lock").success).toBe(false);
    expect(gitBranchNameSchema.safeParse("-main").success).toBe(false);
  });

  test("repository URLs reject credentials, fragments, controls, and unsupported schemes", () => {
    expect(remoteRepositoryUrlSchema.safeParse("https://example.com/repository.git").success).toBe(true);
    expect(remoteRepositoryUrlSchema.safeParse("ssh://example.com/repository.git").success).toBe(true);
    expect(remoteRepositoryUrlSchema.safeParse("ssh://git@example.com/repository.git").success).toBe(true);
    expect(remoteRepositoryUrlSchema.safeParse("https://@example.com/repository.git").success).toBe(false);
    expect(remoteRepositoryUrlSchema.safeParse("https://example.com/repository.git#").success).toBe(false);
    expect(remoteRepositoryUrlSchema.safeParse("https://user:secret@example.com/repository.git").success).toBe(false);
    expect(remoteRepositoryUrlSchema.safeParse("ssh://@example.com/repository.git").success).toBe(false);
    expect(remoteRepositoryUrlSchema.safeParse("ssh://git:secret@example.com/repository.git").success).toBe(false);
    expect(remoteRepositoryUrlSchema.safeParse("git://example.com/repository.git").success).toBe(false);
  });
});

describe("request strictness and accepted configuration identity", () => {
  const configurationRevision = {
    projectId: id,
    revisionId: id2,
    configuration: {
      format: "devspace.project-options/v1",
      hash,
      canonicalJson: '{"aiProfile":null}'
    }
  };

  test("accepts the canonical Project Options envelope and rejects runtime-plan additions", () => {
    expect(configurationRevisionDataSchema.safeParse(configurationRevision).success).toBe(true);
    expect(configurationRevisionDataSchema.safeParse({ ...configurationRevision, runtimePlan: {} }).success).toBe(false);
    expect(configurationRevisionDataSchema.safeParse({
      ...configurationRevision,
      configuration: { ...configurationRevision.configuration, runtimePlanHash: hash }
    }).success).toBe(false);
  });

  test("requires only the exact caller-supplied mutation header set", () => {
    const headers = {
      "X-DevSpace-Protocol-Version": "1",
      "X-DevSpace-Request-Id": id,
      "X-DevSpace-Sent-At": timestamp,
      "X-DevSpace-Operation-Id": id2
    };
    expect(mutationRequestHeadersSchema.safeParse(headers).success).toBe(true);
    const { "X-DevSpace-Operation-Id": _omitted, ...missing } = headers;
    expect(_omitted).toBe(id2);
    expect(mutationRequestHeadersSchema.safeParse(missing).success).toBe(false);
    expect(mutationRequestHeadersSchema.safeParse({ ...headers, "Idempotency-Key": id2 }).success).toBe(false);
    expect(mutationRequestHeadersSchema.safeParse({ ...headers, "X-DevSpace-Request-Hash": hash }).success).toBe(false);
  });

  test("recursively rejects unknown request fields and arbitrary Git refs", () => {
    const valid = {
      projectId: id,
      workspaceId: id2,
      projectSlug: "project",
      workspaceSlug: "workspace",
      kind: "isolated",
      revision: { revisionId: id, revisionHash: hash },
      branchName: "feature/contracts",
      baseRef: { kind: "commit", commit: "a".repeat(40) }
    };
    expect(createWorkspaceDataSchema.safeParse(valid).success).toBe(true);
    expect(createWorkspaceDataSchema.safeParse({
      ...valid, revision: { ...valid.revision, unknown: true }
    }).success).toBe(false);
    expect(createWorkspaceDataSchema.safeParse({ ...valid, baseRef: { kind: "tag", tag: "v1" } }).success).toBe(false);
  });

  test("AI start uses the singular registered aiProfile implicitly", () => {
    const valid = { projectId: id, workspaceId: id2, aiSessionId: id };
    expect(startAiSessionDataSchema.safeParse(valid).success).toBe(true);
    expect(startAiSessionDataSchema.safeParse({ ...valid, profileKey: "default" }).success).toBe(false);
    expect(startAiSessionDataSchema.safeParse({ ...valid, aiProfile: {} }).success).toBe(false);
    expect(resumeAiSessionDataSchema.safeParse({
      projectId: id, workspaceId: id2, sourceAiSessionId: id, aiSessionId: id
    }).success).toBe(false);
  });

  test("every endpoint schema is directly executable", () => {
    for (const endpoint of Object.values(agentApiV1EndpointByOperation)) {
      expect(typeof endpoint.headersSchema.safeParse).toBe("function");
      expect(typeof endpoint.pathParametersSchema.safeParse).toBe("function");
      expect(typeof endpoint.querySchema.safeParse).toBe("function");
      expect(typeof endpoint.requestBodySchema.safeParse).toBe("function");
      expect(endpoint.successBodySchema === null || typeof endpoint.successBodySchema.safeParse === "function").toBe(true);
    }
  });
});

describe("process state-dependent response validation", () => {
  const base = {
    projectId: id, workspaceId: id2, processId: id, kind: "task",
    desiredState: "stopped", exitCode: null
  };

  test.each([
    { observedState: "queued", startedAt: null, finishedAt: null },
    { observedState: "starting", startedAt: null, finishedAt: null },
    { observedState: "starting", startedAt: timestamp, finishedAt: null },
    { observedState: "running", startedAt: timestamp, finishedAt: null },
    { observedState: "stopping", startedAt: timestamp, finishedAt: null },
    { observedState: "failed", startedAt: null, finishedAt: timestamp },
    { observedState: "killed", startedAt: null, finishedAt: timestamp },
    { observedState: "exited", startedAt: timestamp, finishedAt: timestamp, exitCode: 0 },
    { observedState: "lost", startedAt: null, finishedAt: null }
  ])("accepts $observedState relationship", (fields) => {
    expect(processInspectionDataSchema.safeParse({ ...base, ...fields }).success).toBe(true);
  });

  test.each([
    { observedState: "running", startedAt: null, finishedAt: null },
    { observedState: "queued", startedAt: null, finishedAt: timestamp },
    { observedState: "queued", startedAt: timestamp, finishedAt: null },
    { observedState: "lost", startedAt: null, finishedAt: timestamp },
    { observedState: "starting", startedAt: null, finishedAt: null, exitCode: 1 }
  ])("rejects impossible $observedState relationship", (fields) => {
    expect(processInspectionDataSchema.safeParse({ ...base, ...fields }).success).toBe(false);
  });
});
