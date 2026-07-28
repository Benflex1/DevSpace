import { describe, expect, test } from "vitest";
import {
  AI_OUTPUT_DELTA_MAX_BYTES,
  AI_USER_CONTENT_MAX_BYTES,
  acknowledgeAiEventsDataSchema,
  aiApprovalPresentationSchema,
  aiCapabilityResultSchema,
  aiFailureObservationSchema,
  aiProviderCommandSchema,
  aiProviderProfileProjectionSchema,
  aiStreamSynchronizedFrameSchema,
  aiStructuredInputQuestionSchema,
  aiTurnContentSchema,
  aiWorkspaceRelativePathPresentationSchema,
  canonicalAiEventSchema,
  canonicalAiEventTypes,
  classifyAiEventAppend,
  type CanonicalAiEvent
} from "./index.js";

const projectId = "018f1f34-7000-7000-8000-000000000001";
const workspaceId = "018f1f34-7000-7000-8000-000000000002";
const sessionId = "018f1f34-7000-7000-8000-000000000003";
const turnId = "018f1f34-7000-7000-8000-000000000004";
const eventId = "018f1f34-7000-7000-8000-000000000005";
const requestId = "018f1f34-7000-7000-8000-000000000006";
const incidentId = "018f1f34-7000-7000-8000-000000000007";
const timestamp = "2026-07-26T05:00:00.000Z";
const runtimePlanHash = `sha256-jcs-v1:${"a".repeat(64)}`;
const profileRevision = `sha256-ai-profile-v1:${"b".repeat(64)}`;
const profile = { profileId: "codex", profileRevision, provider: "codex" };

function event(input: Record<string, unknown>): CanonicalAiEvent {
  return canonicalAiEventSchema.parse({
    schemaVersion: "devspace.ai-event/v1",
    eventId,
    sessionId,
    turnId,
    sequence: 1,
    observedAt: timestamp,
    profile,
    processGeneration: 1,
    ...input
  });
}

describe("deployment-owned provider projections and commands", () => {
  const capabilities = {
    inspect: true,
    start: true,
    resume: true,
    sendTurn: true,
    interrupt: true,
    approvals: true,
    structuredInput: false,
    stop: true,
    streamEvents: true
  } as const;

  test("accepts only a safe immutable public profile projection", () => {
    const projection = {
      ...profile,
      displayName: "Codex",
      capabilities,
      availability: { state: "available" }
    };
    expect(aiProviderProfileProjectionSchema.parse(projection)).toEqual(projection);
    for (const forbidden of ["executable", "fixedArgs", "environment", "credentialSource", "containerUser"]) {
      expect(aiProviderProfileProjectionSchema.safeParse({ ...projection, [forbidden]: "private" }).success)
        .toBe(false);
    }
    expect(aiProviderProfileProjectionSchema.safeParse({
      ...projection,
      capabilities: { ...capabilities, stop: false }
    }).success).toBe(false);
  });

  test("covers the closed provider-neutral command set", () => {
    const commands = [
      { command: "inspect", projectId, workspaceId, profileId: "codex" },
      {
        command: "start", projectId, workspaceId, aiSessionId: sessionId,
        revisionId: requestId, runtimePlanHash, runtimeGeneration: 1,
        profileId: "codex", profileRevision
      },
      {
        command: "resume", projectId, workspaceId, aiSessionId: sessionId,
        revisionId: requestId, runtimePlanHash, runtimeGeneration: 1,
        profileId: "codex", profileRevision
      },
      {
        command: "sendTurn", projectId, workspaceId, aiSessionId: sessionId, turnId,
        profileId: "codex", profileRevision, processGeneration: 1,
        content: { kind: "text", text: "Review the change." }
      },
      {
        command: "interrupt", projectId, workspaceId, aiSessionId: sessionId, turnId,
        profileId: "codex", profileRevision, processGeneration: 1
      },
      {
        command: "respondToApproval", projectId, workspaceId, aiSessionId: sessionId, turnId,
        profileId: "codex", profileRevision, processGeneration: 1,
        requestId, decision: "approve-once"
      },
      {
        command: "respondToStructuredInput", projectId, workspaceId, aiSessionId: sessionId, turnId,
        profileId: "codex", profileRevision, processGeneration: 1,
        requestId, answers: [{ questionId: "choice", kind: "selected", optionId: "yes" }]
      },
      {
        command: "stop", projectId, workspaceId, aiSessionId: sessionId,
        profileId: "codex", profileRevision, processGeneration: 1
      },
      {
        command: "streamEvents", projectId, workspaceId, aiSessionId: sessionId,
        profileId: "codex", profileRevision, processGeneration: 1, afterSequence: 0
      }
    ];
    expect(commands.map((command) => aiProviderCommandSchema.parse(command).command)).toEqual([
      "inspect",
      "start",
      "resume",
      "sendTurn",
      "interrupt",
      "respondToApproval",
      "respondToStructuredInput",
      "stop",
      "streamEvents"
    ]);
  });

  test.each(["start", "resume"] as const)(
    "requires the inspected profile revision on %s",
    (command) => {
      expect(aiProviderCommandSchema.safeParse({
        command,
        projectId,
        workspaceId,
        aiSessionId: sessionId,
        revisionId: requestId,
        runtimePlanHash,
        runtimeGeneration: 1,
        profileId: "codex"
      }).success).toBe(false);
    }
  );

  test.each(["executable", "args", "environment", "cwd", "containerId", "providerThreadId"])(
    "turn content cannot add %s authority",
    (field) => {
      expect(aiProviderCommandSchema.safeParse({
        command: "sendTurn", projectId, workspaceId, aiSessionId: sessionId, turnId,
        profileId: "codex", profileRevision, processGeneration: 1,
        content: { kind: "text", text: "Run tests", [field]: "forbidden" }
      }).success).toBe(false);
    }
  );

  test("represents unsupported optional behavior without provider branching", () => {
    expect(aiCapabilityResultSchema.parse({
      supported: false,
      code: "AI_CAPABILITY_UNSUPPORTED",
      capability: "structuredInput"
    })).toBeDefined();
    expect(aiCapabilityResultSchema.safeParse({
      supported: false,
      code: "CODEX_UNSUPPORTED",
      capability: "structuredInput"
    }).success).toBe(false);
  });
});

describe("content-plane bounds and safe presentations", () => {
  test("measures user content and deltas in UTF-8 bytes", () => {
    expect(aiTurnContentSchema.safeParse({
      kind: "text", text: "é".repeat(AI_USER_CONTENT_MAX_BYTES / 2)
    }).success).toBe(true);
    expect(aiTurnContentSchema.safeParse({
      kind: "text", text: `${"é".repeat(AI_USER_CONTENT_MAX_BYTES / 2)}a`
    }).success).toBe(false);
    expect(canonicalAiEventSchema.safeParse({
      schemaVersion: "devspace.ai-event/v1",
      eventId,
      sessionId,
      turnId,
      sequence: 1,
      observedAt: timestamp,
      profile,
      processGeneration: 1,
      eventType: "turn.output.delta",
      payload: { stream: "assistant", text: "a".repeat(AI_OUTPUT_DELTA_MAX_BYTES + 1) }
    }).success).toBe(false);
  });

  test.each(["/workspace/src/a.ts", "../secret", "src/../secret", "src\\secret", "src//a"])(
    "rejects unsafe presentation path %s",
    (path) => {
      expect(aiWorkspaceRelativePathPresentationSchema.safeParse(path).success).toBe(false);
    }
  );

  test("allows a bounded redacted command presentation without granting authority", () => {
    expect(aiApprovalPresentationSchema.parse({
      kind: "command",
      summary: "Run the focused tests",
      commandText: "pnpm test --filter contracts",
      workingDirectory: "packages/contracts",
      risk: "read",
      redacted: true
    })).toBeDefined();
    expect(aiApprovalPresentationSchema.safeParse({
      kind: "command",
      summary: "Run a command",
      commandText: "echo token",
      workingDirectory: "packages/contracts",
      risk: "unknown",
      redacted: false
    }).success).toBe(false);
  });

  test("keeps structured input non-secret and closed", () => {
    const question = {
      questionId: "scope",
      header: "Scope",
      question: "Which scope?",
      responseKind: "single-select",
      secret: false,
      options: [{ optionId: "focused", label: "Focused", description: "" }]
    };
    expect(aiStructuredInputQuestionSchema.parse(question)).toEqual(question);
    expect(aiStructuredInputQuestionSchema.safeParse({ ...question, secret: true }).success).toBe(false);
    expect(aiProviderCommandSchema.safeParse({
      command: "respondToStructuredInput",
      projectId,
      workspaceId,
      aiSessionId: sessionId,
      turnId,
      profileId: "codex",
      profileRevision,
      processGeneration: 1,
      requestId,
      answers: [
        { questionId: "scope", kind: "text", text: "first" },
        { questionId: "scope", kind: "text", text: "duplicate" }
      ]
    }).success).toBe(false);
  });
});

describe("canonical event envelope and append decisions", () => {
  const payloadByType: Readonly<Record<string, unknown>> = {
    "session.started": { processGeneration: 1 },
    "session.ready": {},
    "session.stopping": { reason: "user-request" },
    "session.stopped": { reason: "user-request" },
    "session.unavailable": { code: "PROFILE_UNAVAILABLE" },
    "session.lost": { code: "AGENT_RESTART" },
    "turn.accepted": { content: { kind: "text", text: "Hello" } },
    "turn.started": {},
    "turn.output.delta": { stream: "assistant", text: "Hi" },
    "turn.output.completed": { stream: "assistant", text: "Hi" },
    "turn.activity.started": {
      activityId: requestId,
      presentation: { kind: "analysis", summary: "Reviewing" }
    },
    "turn.activity.completed": { activityId: requestId, outcome: "succeeded" },
    "turn.approval.requested": {
      requestId,
      presentation: {
        kind: "file-change",
        summary: "Edit a file",
        paths: ["src/index.ts"],
        truncated: false,
        redacted: true
      }
    },
    "turn.approval.responded": { requestId, decision: "approve-once" },
    "turn.input.requested": {
      requestId,
      questions: [{
        questionId: "scope",
        header: "Scope",
        question: "Choose",
        responseKind: "text",
        secret: false,
        options: []
      }]
    },
    "turn.input.responded": {
      requestId,
      answers: [{ questionId: "scope", kind: "text", text: "focused" }]
    },
    "turn.interrupt.requested": {},
    "turn.interrupted": { reason: "provider-confirmed" },
    "turn.provider-completed": { outcome: "completed" },
    "turn.quiesced": { outcome: "completed" },
    "turn.files.changed": {
      files: [{ change: "added", path: "devspace-ai-beta-check.txt", oldPath: null }],
      truncated: false
    },
    "turn.failed": {
      failure: { code: "AI_PROVIDER_PROTOCOL_FAILURE", category: "protocol-failure", incidentId }
    },
    "turn.lost": { code: "AGENT_RESTART" }
  };

  test("has the exact closed 23-event family with session/turn identity rules", () => {
    expect(canonicalAiEventTypes).toEqual(Object.keys(payloadByType));
    expect(canonicalAiEventTypes).toHaveLength(23);
    for (const eventType of canonicalAiEventTypes) {
      const sessionScoped = eventType.startsWith("session.");
      expect(canonicalAiEventSchema.safeParse({
        schemaVersion: "devspace.ai-event/v1",
        eventId,
        sessionId,
        turnId: sessionScoped ? null : turnId,
        sequence: 1,
        observedAt: timestamp,
        profile,
        processGeneration: 1,
        eventType,
        payload: payloadByType[eventType]
      }).success, eventType).toBe(true);
    }
  });

  test("bounds changed-file presentations and requires safe rename paths", () => {
    const base = {
      ...event({
        eventType: "turn.files.changed",
        payload: {
          files: [{ change: "renamed", path: "src/new.ts", oldPath: "src/old.ts" }],
          truncated: false
        }
      }),
      turnId
    };
    expect(base).toBeDefined();
    expect(canonicalAiEventSchema.safeParse({
      ...base,
      payload: { files: [{ change: "renamed", path: "src/new.ts", oldPath: null }], truncated: false }
    }).success).toBe(false);
    expect(canonicalAiEventSchema.safeParse({
      ...base,
      payload: { files: [{ change: "modified", path: "../secret", oldPath: null }], truncated: false }
    }).success).toBe(false);
  });

  test("rejects unknown envelope and payload fields", () => {
    const ready = event({ turnId: null, eventType: "session.ready", payload: {} });
    expect(canonicalAiEventSchema.safeParse({ ...ready, nativeThreadId: "private" }).success).toBe(false);
    expect(canonicalAiEventSchema.safeParse({
      ...ready, payload: { rawProviderPayload: {} }
    }).success).toBe(false);
  });

  test("accepts append and exact replay while rejecting gaps and conflicts", () => {
    const first = event({ eventType: "turn.started", payload: {} });
    expect(classifyAiEventAppend({
      durableThroughSequence: 0,
      existingAtSequence: null,
      existingByEventId: null,
      incoming: first
    })).toEqual({ kind: "append", sequence: 1 });
    expect(classifyAiEventAppend({
      durableThroughSequence: 1,
      existingAtSequence: first,
      existingByEventId: first,
      incoming: first
    })).toEqual({ kind: "exact-duplicate", sequence: 1 });
    const reorderedFirst = {
      payload: first.payload,
      eventType: first.eventType,
      processGeneration: first.processGeneration,
      profile: first.profile,
      observedAt: first.observedAt,
      sequence: first.sequence,
      turnId: first.turnId,
      sessionId: first.sessionId,
      eventId: first.eventId,
      schemaVersion: first.schemaVersion
    } as CanonicalAiEvent;
    expect(classifyAiEventAppend({
      durableThroughSequence: 1,
      existingAtSequence: first,
      existingByEventId: first,
      incoming: reorderedFirst
    })).toEqual({ kind: "exact-duplicate", sequence: 1 });
    expect(classifyAiEventAppend({
      durableThroughSequence: 1,
      existingAtSequence: null,
      existingByEventId: null,
      incoming: { ...first, eventId: requestId, sequence: 3 }
    })).toEqual({ kind: "gap", expectedSequence: 2, receivedSequence: 3 });
    const gapped = canonicalAiEventSchema.parse({
      ...first,
      eventId: requestId,
      sequence: 3
    });
    const foreignSameNumericSequence = canonicalAiEventSchema.parse({
      ...gapped,
      sessionId: workspaceId
    });
    expect(classifyAiEventAppend({
      durableThroughSequence: 1,
      existingAtSequence: null,
      existingByEventId: foreignSameNumericSequence,
      incoming: gapped
    })).toEqual({ kind: "conflict", sequence: 3 });
    expect(classifyAiEventAppend({
      durableThroughSequence: 1,
      existingAtSequence: first,
      existingByEventId: null,
      incoming: event({ eventType: "turn.interrupt.requested", payload: {} })
    })).toEqual({ kind: "conflict", sequence: 1 });

    expect(classifyAiEventAppend({
      durableThroughSequence: 1,
      existingAtSequence: null,
      existingByEventId: first,
      incoming: { ...first, sequence: 2 }
    })).toEqual({ kind: "conflict", sequence: 2 });

    expect(classifyAiEventAppend({
      durableThroughSequence: 1,
      existingAtSequence: null,
      existingByEventId: null,
      incoming: first
    })).toEqual({ kind: "conflict", sequence: 1 });
  });

  test("defines strict synchronization and acknowledgement controls", () => {
    expect(aiStreamSynchronizedFrameSchema.parse({
      schemaVersion: "devspace.ai-stream/v1",
      frameType: "stream.synchronized",
      sessionId,
      throughSequence: 0
    })).toBeDefined();
    expect(acknowledgeAiEventsDataSchema.parse({
      projectId,
      workspaceId,
      aiSessionId: sessionId,
      throughSequence: 1,
      throughEventId: eventId
    })).toBeDefined();
  });
});

describe("closed failure policy", () => {
  test.each([
    ["AI_PROFILE_NOT_FOUND", "user-error", null],
    ["AI_PROFILE_UNAVAILABLE", "dependency-unavailable", null],
    ["AI_PROFILE_REVISION_CONFLICT", "state-conflict", null],
    ["AI_SESSION_STATE_CONFLICT", "state-conflict", null],
    ["AI_PROVIDER_TRANSPORT_FAILURE", "transport-failure", incidentId],
    ["AI_PROVIDER_PROTOCOL_FAILURE", "protocol-failure", incidentId],
    ["AI_INTERNAL_FAILURE", "internal-failure", incidentId]
  ] as const)("accepts %s only with its category and incident policy", (code, category, incident) => {
    expect(aiFailureObservationSchema.parse({ code, category, incidentId: incident })).toBeDefined();
    expect(aiFailureObservationSchema.safeParse({
      code,
      category: category === "user-error" ? "internal-failure" : "user-error",
      incidentId: incident
    }).success).toBe(false);
  });
});
