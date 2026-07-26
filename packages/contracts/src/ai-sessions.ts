import * as z from "zod";
import {
  aiInteractionRequestStates,
  aiProviderProcessStates,
  aiSessionV1States,
  aiTurnStates
} from "@devspace/domain";
import {
  configurationKeySchema,
  projectOptionsRevisionHashSchema,
  utcTimestampMsSchema,
  uuidV7Schema
} from "./primitives.js";

export const AI_EVENT_SCHEMA_VERSION = "devspace.ai-event/v1" as const;
export const AI_STREAM_SCHEMA_VERSION = "devspace.ai-stream/v1" as const;
export const AI_EVENT_NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8" as const;
export const AI_USER_CONTENT_MAX_BYTES = 262_144;
export const AI_OUTPUT_DELTA_MAX_BYTES = 65_536;
export const AI_OUTPUT_ITEM_MAX_BYTES = 1_048_576;
export const AI_PRESENTATION_TEXT_MAX_BYTES = 32_768;
export const AI_WORKSPACE_RELATIVE_PATH_MAX_BYTES = 4_096;
export const AI_MAX_PRESENTATION_PATHS = 256;
export const AI_MAX_STRUCTURED_INPUT_QUESTIONS = 16;
export const AI_MAX_STRUCTURED_INPUT_OPTIONS = 32;

const unicodeScalarString = z.string().refine((value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) {
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          index += 1;
          continue;
        }
      }
      return false;
    }
  }
  return true;
}, "Must contain Unicode scalar values and no NUL");

function boundedContent(maxBytes: number, allowEmpty = false) {
  return unicodeScalarString
    .refine((value) => allowEmpty || value.length > 0, "Must not be empty")
    .refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes, `Must be at most ${maxBytes} UTF-8 bytes`);
}

export const aiProfileRevisionSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const aiProviderKeySchema = configurationKeySchema;
export const aiProviderAvailabilitySchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("available") }),
  z.strictObject({
    state: z.literal("unavailable"),
    code: z.enum([
      "PROFILE_DISABLED",
      "EXECUTABLE_MISSING",
      "VERSION_MISMATCH",
      "RUNTIME_IDENTITY_UNAVAILABLE",
      "CREDENTIAL_SOURCE_UNAVAILABLE",
      "WORKSPACE_REQUIREMENT_UNMET"
    ])
  })
]);
export const aiProviderCapabilitiesSchema = z.strictObject({
  inspect: z.literal(true),
  start: z.literal(true),
  resume: z.boolean(),
  sendTurn: z.literal(true),
  interrupt: z.boolean(),
  approvals: z.boolean(),
  structuredInput: z.boolean(),
  stop: z.literal(true),
  streamEvents: z.literal(true)
});
export const aiProviderProfileProjectionSchema = z.strictObject({
  profileId: configurationKeySchema,
  profileRevision: aiProfileRevisionSchema,
  provider: aiProviderKeySchema,
  displayName: boundedContent(256),
  capabilities: aiProviderCapabilitiesSchema,
  availability: aiProviderAvailabilitySchema
});
export const aiSafeProfileIdentitySchema = z.strictObject({
  profileId: configurationKeySchema,
  profileRevision: aiProfileRevisionSchema,
  provider: aiProviderKeySchema
});

export const aiSessionV1StateSchema = z.enum(aiSessionV1States);
export const aiProviderProcessStateSchema = z.enum(aiProviderProcessStates);
export const aiTurnStateSchema = z.enum(aiTurnStates);
export const aiInteractionRequestStateSchema = z.enum(aiInteractionRequestStates);
export const aiProcessGenerationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const aiEventSequenceSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const aiAfterSequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const runtimeGenerationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const aiWorkspaceRelativePathPresentationSchema = boundedContent(
  AI_WORKSPACE_RELATIVE_PATH_MAX_BYTES
).refine((value) => {
  if (value === ".") return true;
  if (value.startsWith("/") || value.startsWith("\\") || value.includes("\\")) return false;
  const components = value.split("/");
  return components.every((component) => component.length > 0 && component !== "." && component !== "..");
}, "Must be a canonical workspace-relative presentation path");

export const aiTurnContentSchema = z.strictObject({
  kind: z.literal("text"),
  text: boundedContent(AI_USER_CONTENT_MAX_BYTES)
});

export const aiCommandApprovalPresentationSchema = z.strictObject({
  kind: z.literal("command"),
  summary: boundedContent(4_096),
  commandText: boundedContent(AI_PRESENTATION_TEXT_MAX_BYTES),
  workingDirectory: aiWorkspaceRelativePathPresentationSchema.nullable(),
  risk: z.enum(["read", "write", "network", "mixed", "unknown"]),
  redacted: z.literal(true)
});
export const aiFileChangeApprovalPresentationSchema = z.strictObject({
  kind: z.literal("file-change"),
  summary: boundedContent(4_096),
  paths: z.array(aiWorkspaceRelativePathPresentationSchema)
    .max(AI_MAX_PRESENTATION_PATHS)
    .refine((paths) => new Set(paths).size === paths.length, "Paths must be unique"),
  truncated: z.boolean(),
  redacted: z.literal(true)
});
export const aiApprovalPresentationSchema = z.discriminatedUnion("kind", [
  aiCommandApprovalPresentationSchema,
  aiFileChangeApprovalPresentationSchema
]);
export const aiApprovalDecisionSchema = z.enum([
  "approve-once",
  "approve-for-session",
  "deny",
  "cancel"
]);

export const aiStructuredInputOptionSchema = z.strictObject({
  optionId: configurationKeySchema,
  label: boundedContent(256),
  description: boundedContent(2_048, true)
});
export const aiStructuredInputQuestionSchema = z.strictObject({
  questionId: configurationKeySchema,
  header: boundedContent(256),
  question: boundedContent(4_096),
  responseKind: z.enum(["single-select", "text"]),
  secret: z.literal(false),
  options: z.array(aiStructuredInputOptionSchema).max(AI_MAX_STRUCTURED_INPUT_OPTIONS)
}).superRefine((question, context) => {
  if (question.responseKind === "single-select" && question.options.length === 0) {
    context.addIssue({ code: "custom", path: ["options"], message: "A select question needs options" });
  }
  if (question.responseKind === "text" && question.options.length !== 0) {
    context.addIssue({ code: "custom", path: ["options"], message: "A text question cannot have options" });
  }
  if (new Set(question.options.map((option) => option.optionId)).size !== question.options.length) {
    context.addIssue({ code: "custom", path: ["options"], message: "Option IDs must be unique" });
  }
});
export const aiStructuredInputAnswerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    questionId: configurationKeySchema,
    kind: z.literal("selected"),
    optionId: configurationKeySchema
  }),
  z.strictObject({
    questionId: configurationKeySchema,
    kind: z.literal("text"),
    text: boundedContent(AI_USER_CONTENT_MAX_BYTES, true)
  })
]);
export const aiStructuredInputQuestionsSchema = z.array(aiStructuredInputQuestionSchema)
  .min(1)
  .max(AI_MAX_STRUCTURED_INPUT_QUESTIONS)
  .refine(
    (questions) => new Set(questions.map((question) => question.questionId)).size === questions.length,
    "Question IDs must be unique"
  );
export const aiStructuredInputAnswersSchema = z.array(aiStructuredInputAnswerSchema)
  .min(1)
  .max(AI_MAX_STRUCTURED_INPUT_QUESTIONS)
  .refine(
    (answers) => new Set(answers.map((answer) => answer.questionId)).size === answers.length,
    "Answers must bind unique question IDs"
  );

const sessionIdentityFields = {
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  aiSessionId: uuidV7Schema
};
const processBindingFields = {
  ...sessionIdentityFields,
  profileId: configurationKeySchema,
  profileRevision: aiProfileRevisionSchema,
  processGeneration: aiProcessGenerationSchema
};
const turnBindingFields = {
  ...processBindingFields,
  turnId: uuidV7Schema
};

export const inspectAiProviderCommandSchema = z.strictObject({
  command: z.literal("inspect"),
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  profileId: configurationKeySchema
});
export const startAiProviderCommandSchema = z.strictObject({
  command: z.literal("start"),
  ...sessionIdentityFields,
  revisionId: uuidV7Schema,
  runtimePlanHash: projectOptionsRevisionHashSchema,
  runtimeGeneration: runtimeGenerationSchema,
  profileId: configurationKeySchema
});
export const resumeAiProviderCommandSchema = z.strictObject({
  command: z.literal("resume"),
  ...sessionIdentityFields,
  revisionId: uuidV7Schema,
  runtimePlanHash: projectOptionsRevisionHashSchema,
  runtimeGeneration: runtimeGenerationSchema,
  profileId: configurationKeySchema
});
export const sendAiTurnCommandSchema = z.strictObject({
  command: z.literal("sendTurn"),
  ...turnBindingFields,
  content: aiTurnContentSchema
});
export const interruptAiTurnCommandSchema = z.strictObject({
  command: z.literal("interrupt"),
  ...turnBindingFields
});
export const respondToAiApprovalCommandSchema = z.strictObject({
  command: z.literal("respondToApproval"),
  ...turnBindingFields,
  requestId: uuidV7Schema,
  decision: aiApprovalDecisionSchema
});
export const respondToAiStructuredInputCommandSchema = z.strictObject({
  command: z.literal("respondToStructuredInput"),
  ...turnBindingFields,
  requestId: uuidV7Schema,
  answers: aiStructuredInputAnswersSchema
});
export const stopAiProviderCommandSchema = z.strictObject({
  command: z.literal("stop"),
  ...processBindingFields
});
export const streamAiEventsCommandSchema = z.strictObject({
  command: z.literal("streamEvents"),
  ...processBindingFields,
  afterSequence: aiAfterSequenceSchema
});
export const aiProviderCommandSchema = z.discriminatedUnion("command", [
  inspectAiProviderCommandSchema,
  startAiProviderCommandSchema,
  resumeAiProviderCommandSchema,
  sendAiTurnCommandSchema,
  interruptAiTurnCommandSchema,
  respondToAiApprovalCommandSchema,
  respondToAiStructuredInputCommandSchema,
  stopAiProviderCommandSchema,
  streamAiEventsCommandSchema
]);

export const aiCapabilityResultSchema = z.discriminatedUnion("supported", [
  z.strictObject({ supported: z.literal(true) }),
  z.strictObject({
    supported: z.literal(false),
    code: z.literal("AI_CAPABILITY_UNSUPPORTED"),
    capability: z.enum(["resume", "interrupt", "approvals", "structuredInput"])
  })
]);

export const aiFailureCategorySchema = z.enum([
  "user-error",
  "state-conflict",
  "dependency-unavailable",
  "transport-failure",
  "protocol-failure",
  "internal-failure"
]);
export const aiFailureCodes = [
  "AI_PROFILE_NOT_FOUND",
  "AI_PROFILE_UNAVAILABLE",
  "AI_CAPABILITY_UNSUPPORTED",
  "AI_SESSION_STATE_CONFLICT",
  "AI_TURN_STATE_CONFLICT",
  "AI_INTERACTION_STATE_CONFLICT",
  "AI_IDENTITY_MISMATCH",
  "AI_EVENT_SEQUENCE_CONFLICT",
  "AI_EVENT_GAP",
  "AI_OUTBOX_UNAVAILABLE",
  "AI_PROVIDER_TRANSPORT_FAILURE",
  "AI_PROVIDER_PROTOCOL_FAILURE",
  "AI_INTERNAL_FAILURE"
] as const;
export const aiFailureCodeSchema = z.enum(aiFailureCodes);
export type AiFailureCode = (typeof aiFailureCodes)[number];
const aiFailurePolicy: Readonly<Record<AiFailureCode, {
  readonly category: z.infer<typeof aiFailureCategorySchema>;
  readonly incident: boolean;
}>> = {
  AI_PROFILE_NOT_FOUND: { category: "user-error", incident: false },
  AI_PROFILE_UNAVAILABLE: { category: "dependency-unavailable", incident: false },
  AI_CAPABILITY_UNSUPPORTED: { category: "user-error", incident: false },
  AI_SESSION_STATE_CONFLICT: { category: "state-conflict", incident: false },
  AI_TURN_STATE_CONFLICT: { category: "state-conflict", incident: false },
  AI_INTERACTION_STATE_CONFLICT: { category: "state-conflict", incident: false },
  AI_IDENTITY_MISMATCH: { category: "internal-failure", incident: true },
  AI_EVENT_SEQUENCE_CONFLICT: { category: "protocol-failure", incident: true },
  AI_EVENT_GAP: { category: "protocol-failure", incident: true },
  AI_OUTBOX_UNAVAILABLE: { category: "dependency-unavailable", incident: true },
  AI_PROVIDER_TRANSPORT_FAILURE: { category: "transport-failure", incident: true },
  AI_PROVIDER_PROTOCOL_FAILURE: { category: "protocol-failure", incident: true },
  AI_INTERNAL_FAILURE: { category: "internal-failure", incident: true }
};
export const aiFailureObservationSchema = z.strictObject({
  code: aiFailureCodeSchema,
  category: aiFailureCategorySchema,
  incidentId: uuidV7Schema.nullable()
}).superRefine((failure, context) => {
  const policy = aiFailurePolicy[failure.code];
  if (failure.category !== policy.category) {
    context.addIssue({ code: "custom", path: ["category"], message: "Failure category does not match code" });
  }
  if ((failure.incidentId !== null) !== policy.incident) {
    context.addIssue({ code: "custom", path: ["incidentId"], message: "Incident policy does not match code" });
  }
});

export const aiActivityPresentationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    summary: boundedContent(4_096),
    commandText: boundedContent(AI_PRESENTATION_TEXT_MAX_BYTES),
    workingDirectory: aiWorkspaceRelativePathPresentationSchema.nullable(),
    redacted: z.literal(true)
  }),
  z.strictObject({
    kind: z.literal("file-change"),
    summary: boundedContent(4_096),
    paths: z.array(aiWorkspaceRelativePathPresentationSchema)
      .max(AI_MAX_PRESENTATION_PATHS)
      .refine((paths) => new Set(paths).size === paths.length, "Paths must be unique"),
    truncated: z.boolean(),
    redacted: z.literal(true)
  }),
  z.strictObject({
    kind: z.literal("analysis"),
    summary: boundedContent(AI_PRESENTATION_TEXT_MAX_BYTES)
  })
]);

const canonicalEventCommon = {
  schemaVersion: z.literal(AI_EVENT_SCHEMA_VERSION),
  eventId: uuidV7Schema,
  sessionId: uuidV7Schema,
  sequence: aiEventSequenceSchema,
  observedAt: utcTimestampMsSchema,
  profile: aiSafeProfileIdentitySchema,
  processGeneration: aiProcessGenerationSchema
};
const sessionEvent = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload
) => z.strictObject({
  ...canonicalEventCommon,
  turnId: z.null(),
  eventType: z.literal(eventType),
  payload
});
const turnEvent = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload
) => z.strictObject({
  ...canonicalEventCommon,
  turnId: uuidV7Schema,
  eventType: z.literal(eventType),
  payload
});
const emptyPayload = z.strictObject({});
const sessionUnavailableCode = z.enum([
  "PROFILE_UNAVAILABLE",
  "WORKSPACE_RUNTIME_UNAVAILABLE",
  "PROVIDER_PROCESS_START_FAILED"
]);
const sessionLostCode = z.enum([
  "AGENT_RESTART",
  "RUNTIME_REPLACED",
  "OWNERSHIP_AMBIGUOUS",
  "EVENT_HISTORY_UNAVAILABLE"
]);

const canonicalAiEventSchemas = [
  sessionEvent("session.started", z.strictObject({ processGeneration: aiProcessGenerationSchema })),
  sessionEvent("session.ready", emptyPayload),
  sessionEvent("session.stopping", z.strictObject({
    reason: z.enum(["user-request", "runtime-stopping", "session-retired"])
  })),
  sessionEvent("session.stopped", z.strictObject({
    reason: z.enum(["user-request", "runtime-stopped", "session-retired", "provider-exited"])
  })),
  sessionEvent("session.unavailable", z.strictObject({ code: sessionUnavailableCode })),
  sessionEvent("session.lost", z.strictObject({ code: sessionLostCode })),
  turnEvent("turn.accepted", z.strictObject({ content: aiTurnContentSchema })),
  turnEvent("turn.started", emptyPayload),
  turnEvent("turn.output.delta", z.strictObject({
    stream: z.literal("assistant"),
    text: boundedContent(AI_OUTPUT_DELTA_MAX_BYTES)
  })),
  turnEvent("turn.output.completed", z.strictObject({
    stream: z.literal("assistant"),
    text: boundedContent(AI_OUTPUT_ITEM_MAX_BYTES, true)
  })),
  turnEvent("turn.activity.started", z.strictObject({
    activityId: uuidV7Schema,
    presentation: aiActivityPresentationSchema
  })),
  turnEvent("turn.activity.completed", z.strictObject({
    activityId: uuidV7Schema,
    outcome: z.enum(["succeeded", "failed", "cancelled"])
  })),
  turnEvent("turn.approval.requested", z.strictObject({
    requestId: uuidV7Schema,
    presentation: aiApprovalPresentationSchema
  })),
  turnEvent("turn.approval.responded", z.strictObject({
    requestId: uuidV7Schema,
    decision: aiApprovalDecisionSchema
  })),
  turnEvent("turn.input.requested", z.strictObject({
    requestId: uuidV7Schema,
    questions: aiStructuredInputQuestionsSchema
  })),
  turnEvent("turn.input.responded", z.strictObject({
    requestId: uuidV7Schema,
    answers: aiStructuredInputAnswersSchema
  })),
  turnEvent("turn.interrupt.requested", emptyPayload),
  turnEvent("turn.interrupted", z.strictObject({
    reason: z.enum(["user-request", "provider-confirmed", "provider-process-stopped"])
  })),
  turnEvent("turn.provider-completed", z.strictObject({
    outcome: z.enum(["completed", "interrupted", "failed"])
  })),
  turnEvent("turn.quiesced", z.strictObject({
    outcome: z.enum(["completed", "interrupted", "failed"])
  })),
  turnEvent("turn.failed", z.strictObject({ failure: aiFailureObservationSchema })),
  turnEvent("turn.lost", z.strictObject({ code: sessionLostCode }))
] as const;

export const canonicalAiEventSchema = z.discriminatedUnion(
  "eventType",
  canonicalAiEventSchemas
);
export const canonicalAiEventTypes = Object.freeze(canonicalAiEventSchemas.map(
  (schema) => schema.shape.eventType.value
));
export type CanonicalAiEvent = z.infer<typeof canonicalAiEventSchema>;

export const aiStreamSynchronizedFrameSchema = z.strictObject({
  schemaVersion: z.literal(AI_STREAM_SCHEMA_VERSION),
  frameType: z.literal("stream.synchronized"),
  sessionId: uuidV7Schema,
  throughSequence: aiAfterSequenceSchema
});
export const aiEventStreamFrameSchema = z.union([
  canonicalAiEventSchema,
  aiStreamSynchronizedFrameSchema
]);
export const acknowledgeAiEventsDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  aiSessionId: uuidV7Schema,
  throughSequence: aiEventSequenceSchema,
  throughEventId: uuidV7Schema
});

export type AiEventAppendDecision =
  | { readonly kind: "append"; readonly sequence: number }
  | { readonly kind: "exact-duplicate"; readonly sequence: number }
  | { readonly kind: "gap"; readonly expectedSequence: number; readonly receivedSequence: number }
  | { readonly kind: "conflict"; readonly sequence: number };

export function classifyAiEventAppend(input: {
  readonly durableThroughSequence: number;
  readonly existingAtSequence: CanonicalAiEvent | null;
  readonly incoming: CanonicalAiEvent;
}): AiEventAppendDecision {
  const through = aiAfterSequenceSchema.parse(input.durableThroughSequence);
  const incoming = canonicalAiEventSchema.parse(input.incoming);
  const expected = through + 1;
  if (incoming.sequence === expected) {
    if (input.existingAtSequence !== null) return { kind: "conflict", sequence: incoming.sequence };
    return { kind: "append", sequence: incoming.sequence };
  }
  if (incoming.sequence > expected) {
    return { kind: "gap", expectedSequence: expected, receivedSequence: incoming.sequence };
  }
  if (input.existingAtSequence === null) return { kind: "conflict", sequence: incoming.sequence };
  const existing = canonicalAiEventSchema.parse(input.existingAtSequence);
  return JSON.stringify(existing) === JSON.stringify(incoming)
    ? { kind: "exact-duplicate", sequence: incoming.sequence }
    : { kind: "conflict", sequence: incoming.sequence };
}

export type AiProviderProfileProjection = z.infer<typeof aiProviderProfileProjectionSchema>;
export type AiProviderCommand = z.infer<typeof aiProviderCommandSchema>;
export type AiFailureObservation = z.infer<typeof aiFailureObservationSchema>;
