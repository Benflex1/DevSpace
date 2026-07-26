import * as z from "zod";
import {
  AI_EVENT_NDJSON_CONTENT_TYPE,
  acknowledgeAiEventsDataSchema,
  aiAfterSequenceSchema,
  aiFailureCodes,
  aiFailureObservationSchema,
  aiProviderProfileProjectionSchema,
  interruptAiTurnCommandSchema,
  respondToAiApprovalCommandSchema,
  respondToAiStructuredInputCommandSchema,
  resumeAiProviderCommandSchema,
  sendAiTurnCommandSchema,
  startAiProviderCommandSchema,
  stopAiProviderCommandSchema
} from "./ai-sessions.js";
import { buildAgentErrorEnvelopeSchema } from "./errors.js";
import {
  commonRequestHeadersSchema,
  errorMessageSchema,
  mutationReceiptSchema,
  mutationRequestHeadersSchema,
  postBodySchema,
  responseMetaSchema,
  successEnvelopeSchema,
  uuidV7Schema
} from "./primitives.js";

const noPathParametersSchema = z.strictObject({});
const aiSessionPathParametersSchema = z.strictObject({ aiSessionId: uuidV7Schema });
const noQuerySchema = z.undefined();
const noBodySchema = z.undefined();
const inspectProfileDataSchema = z.strictObject({
  projectId: uuidV7Schema,
  workspaceId: uuidV7Schema,
  profileId: startAiProviderCommandSchema.shape.profileId
});
const startDataSchema = startAiProviderCommandSchema.omit({ command: true });
const resumeDataSchema = resumeAiProviderCommandSchema.omit({ command: true });
const sendTurnDataSchema = sendAiTurnCommandSchema.omit({ command: true });
const interruptDataSchema = interruptAiTurnCommandSchema.omit({ command: true });
const approvalDataSchema = respondToAiApprovalCommandSchema.omit({ command: true });
const structuredInputDataSchema = respondToAiStructuredInputCommandSchema.omit({ command: true });
const stopDataSchema = stopAiProviderCommandSchema.omit({ command: true });
const afterSequenceQuerySchema = z.strictObject({
  afterSequence: z.string().regex(/^(?:0|[1-9][0-9]*)$/u).refine((value) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && aiAfterSequenceSchema.safeParse(parsed).success;
  })
});

const f11ErrorPolicy = {
  AI_PROFILE_NOT_FOUND: { status: 404, retryable: false, incident: false },
  AI_PROFILE_UNAVAILABLE: { status: 503, retryable: true, incident: false },
  AI_CAPABILITY_UNSUPPORTED: { status: 422, retryable: false, incident: false },
  AI_SESSION_STATE_CONFLICT: { status: 409, retryable: false, incident: false },
  AI_TURN_STATE_CONFLICT: { status: 409, retryable: false, incident: false },
  AI_INTERACTION_STATE_CONFLICT: { status: 409, retryable: false, incident: false },
  AI_IDENTITY_MISMATCH: { status: 409, retryable: false, incident: true },
  AI_EVENT_SEQUENCE_CONFLICT: { status: 409, retryable: false, incident: true },
  AI_EVENT_GAP: { status: 409, retryable: false, incident: true },
  AI_OUTBOX_UNAVAILABLE: { status: 503, retryable: true, incident: true },
  AI_PROVIDER_TRANSPORT_FAILURE: { status: 502, retryable: true, incident: true },
  AI_PROVIDER_PROTOCOL_FAILURE: { status: 502, retryable: false, incident: true },
  AI_INTERNAL_FAILURE: { status: 500, retryable: true, incident: true }
} as const;

function aiErrorSchema<const Code extends (typeof aiFailureCodes)[number]>(code: Code) {
  const policy = f11ErrorPolicy[code];
  return z.strictObject({
    meta: responseMetaSchema,
    error: z.strictObject({
      code: z.literal(code),
      message: errorMessageSchema,
      retryable: z.literal(policy.retryable),
      failure: aiFailureObservationSchema.refine((failure) => failure.code === code)
    })
  });
}

type AiErrorCode = (typeof aiFailureCodes)[number];
type F11ErrorDescriptor = {
  readonly code: string;
  readonly statuses: readonly number[];
  readonly schema: z.ZodType;
};
const commonErrors: readonly F11ErrorDescriptor[] = [
  {
    code: "PROTOCOL_VERSION_UNSUPPORTED",
    statuses: [400, 426],
    schema: buildAgentErrorEnvelopeSchema("PROTOCOL_VERSION_UNSUPPORTED")
  },
  {
    code: "REQUEST_INVALID",
    statuses: [400],
    schema: buildAgentErrorEnvelopeSchema("REQUEST_INVALID")
  },
  {
    code: "AGENT_INTERNAL_ERROR",
    statuses: [500],
    schema: buildAgentErrorEnvelopeSchema("AGENT_INTERNAL_ERROR")
  }
];
const mutationErrors: readonly F11ErrorDescriptor[] = [
  {
    code: "OPERATION_CONFLICT",
    statuses: [409],
    schema: buildAgentErrorEnvelopeSchema("OPERATION_CONFLICT")
  },
  {
    code: "OPERATION_JOURNAL_UNAVAILABLE",
    statuses: [503],
    schema: buildAgentErrorEnvelopeSchema("OPERATION_JOURNAL_UNAVAILABLE")
  }
];

function routeErrors(codes: readonly AiErrorCode[], mutation: boolean) {
  return Object.freeze([
    ...commonErrors,
    ...(mutation ? mutationErrors : []),
    ...codes.map((code) => ({
      code,
      statuses: [f11ErrorPolicy[code].status] as readonly number[],
      schema: aiErrorSchema(code)
    }))
  ]);
}

function errorUnion(errors: readonly F11ErrorDescriptor[]) {
  return z.union(errors.map((error) => error.schema) as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

function mutationEndpoint(input: {
  readonly operation: string;
  readonly path: `/v1/${string}`;
  readonly requestDataSchema: z.ZodType;
  readonly errorCodes: readonly AiErrorCode[];
}) {
  const errors = routeErrors(input.errorCodes, true);
  return Object.freeze({
    operation: input.operation,
    method: "POST" as const,
    path: input.path,
    classification: "mutation" as const,
    journaledMutation: true,
    requiredDevSpaceHeaders: Object.freeze([
      "X-DevSpace-Protocol-Version",
      "X-DevSpace-Request-Id",
      "X-DevSpace-Sent-At",
      "X-DevSpace-Operation-Id"
    ]),
    headersSchema: mutationRequestHeadersSchema,
    pathParametersSchema: noPathParametersSchema,
    querySchema: noQuerySchema,
    requestBodySchema: postBodySchema(input.requestDataSchema),
    requestDataSchema: input.requestDataSchema,
    successStatus: 202 as const,
    successBodySchema: successEnvelopeSchema(mutationReceiptSchema),
    successDataSchema: mutationReceiptSchema,
    successContentType: "application/json" as const,
    responseKind: "json-envelope" as const,
    errorsAfterSuccessBegins: false,
    errors,
    errorSchema: errorUnion(errors)
  });
}

const identityErrors = [
  "AI_PROFILE_NOT_FOUND",
  "AI_PROFILE_UNAVAILABLE",
  "AI_IDENTITY_MISMATCH",
  "AI_SESSION_STATE_CONFLICT"
] as const;

const inspectErrors = routeErrors(["AI_PROFILE_NOT_FOUND", "AI_INTERNAL_FAILURE"], false);
const streamErrors = routeErrors([
  "AI_IDENTITY_MISMATCH",
  "AI_EVENT_SEQUENCE_CONFLICT",
  "AI_EVENT_GAP",
  "AI_OUTBOX_UNAVAILABLE"
], false);
const acknowledgeErrors = routeErrors([
  "AI_IDENTITY_MISMATCH",
  "AI_EVENT_SEQUENCE_CONFLICT",
  "AI_OUTBOX_UNAVAILABLE"
], false);

export const f11AiAgentApiV1Endpoints = Object.freeze([
  Object.freeze({
    operation: "ai-provider.inspect",
    method: "POST" as const,
    path: "/v1/ai-profiles/inspect" as const,
    classification: "non-mutating" as const,
    journaledMutation: false,
    requiredDevSpaceHeaders: Object.freeze([
      "X-DevSpace-Protocol-Version", "X-DevSpace-Request-Id", "X-DevSpace-Sent-At"
    ]),
    headersSchema: commonRequestHeadersSchema,
    pathParametersSchema: noPathParametersSchema,
    querySchema: noQuerySchema,
    requestBodySchema: postBodySchema(inspectProfileDataSchema),
    requestDataSchema: inspectProfileDataSchema,
    successStatus: 200 as const,
    successBodySchema: successEnvelopeSchema(aiProviderProfileProjectionSchema),
    successDataSchema: aiProviderProfileProjectionSchema,
    successContentType: "application/json" as const,
    responseKind: "json-envelope" as const,
    errorsAfterSuccessBegins: false,
    errors: inspectErrors,
    errorSchema: errorUnion(inspectErrors)
  }),
  mutationEndpoint({
    operation: "ai-session.start",
    path: "/v1/ai-sessions/start",
    requestDataSchema: startDataSchema,
    errorCodes: [...identityErrors, "AI_OUTBOX_UNAVAILABLE"]
  }),
  mutationEndpoint({
    operation: "ai-session.resume",
    path: "/v1/ai-sessions/resume",
    requestDataSchema: resumeDataSchema,
    errorCodes: [...identityErrors, "AI_CAPABILITY_UNSUPPORTED", "AI_OUTBOX_UNAVAILABLE"]
  }),
  mutationEndpoint({
    operation: "ai-session.turn.send",
    path: "/v1/ai-sessions/send-turn",
    requestDataSchema: sendTurnDataSchema,
    errorCodes: [...identityErrors, "AI_TURN_STATE_CONFLICT", "AI_OUTBOX_UNAVAILABLE"]
  }),
  mutationEndpoint({
    operation: "ai-session.turn.interrupt",
    path: "/v1/ai-sessions/interrupt",
    requestDataSchema: interruptDataSchema,
    errorCodes: [
      ...identityErrors,
      "AI_CAPABILITY_UNSUPPORTED",
      "AI_TURN_STATE_CONFLICT",
      "AI_OUTBOX_UNAVAILABLE"
    ]
  }),
  mutationEndpoint({
    operation: "ai-session.approval.respond",
    path: "/v1/ai-sessions/respond-approval",
    requestDataSchema: approvalDataSchema,
    errorCodes: [
      ...identityErrors,
      "AI_CAPABILITY_UNSUPPORTED",
      "AI_TURN_STATE_CONFLICT",
      "AI_INTERACTION_STATE_CONFLICT",
      "AI_OUTBOX_UNAVAILABLE"
    ]
  }),
  mutationEndpoint({
    operation: "ai-session.input.respond",
    path: "/v1/ai-sessions/respond-input",
    requestDataSchema: structuredInputDataSchema,
    errorCodes: [
      ...identityErrors,
      "AI_CAPABILITY_UNSUPPORTED",
      "AI_TURN_STATE_CONFLICT",
      "AI_INTERACTION_STATE_CONFLICT",
      "AI_OUTBOX_UNAVAILABLE"
    ]
  }),
  mutationEndpoint({
    operation: "ai-session.stop",
    path: "/v1/ai-sessions/stop",
    requestDataSchema: stopDataSchema,
    errorCodes: [...identityErrors, "AI_OUTBOX_UNAVAILABLE"]
  }),
  Object.freeze({
    operation: "ai-session.events.stream",
    method: "GET" as const,
    path: "/v1/ai-sessions/{aiSessionId}/events" as const,
    classification: "non-mutating" as const,
    journaledMutation: false,
    requiredDevSpaceHeaders: Object.freeze([
      "X-DevSpace-Protocol-Version", "X-DevSpace-Request-Id", "X-DevSpace-Sent-At"
    ]),
    headersSchema: commonRequestHeadersSchema,
    pathParametersSchema: aiSessionPathParametersSchema,
    querySchema: afterSequenceQuerySchema,
    requestBodySchema: noBodySchema,
    requestDataSchema: null,
    successStatus: 200 as const,
    successBodySchema: null,
    successDataSchema: null,
    successContentType: AI_EVENT_NDJSON_CONTENT_TYPE,
    responseKind: "ndjson-stream" as const,
    errorsAfterSuccessBegins: false,
    errors: streamErrors,
    errorSchema: errorUnion(streamErrors)
  }),
  Object.freeze({
    operation: "ai-session.events.acknowledge",
    method: "POST" as const,
    path: "/v1/ai-sessions/acknowledge-events" as const,
    classification: "non-mutating" as const,
    journaledMutation: false,
    requiredDevSpaceHeaders: Object.freeze([
      "X-DevSpace-Protocol-Version", "X-DevSpace-Request-Id", "X-DevSpace-Sent-At"
    ]),
    headersSchema: commonRequestHeadersSchema,
    pathParametersSchema: noPathParametersSchema,
    querySchema: noQuerySchema,
    requestBodySchema: postBodySchema(acknowledgeAiEventsDataSchema),
    requestDataSchema: acknowledgeAiEventsDataSchema,
    successStatus: 200 as const,
    successBodySchema: successEnvelopeSchema(acknowledgeAiEventsDataSchema),
    successDataSchema: acknowledgeAiEventsDataSchema,
    successContentType: "application/json" as const,
    responseKind: "json-envelope" as const,
    errorsAfterSuccessBegins: false,
    errors: acknowledgeErrors,
    errorSchema: errorUnion(acknowledgeErrors)
  })
]);

export type F11AiAgentApiV1Endpoint = (typeof f11AiAgentApiV1Endpoints)[number];
export type F11AiAgentApiV1Operation = F11AiAgentApiV1Endpoint["operation"];
export const f11AiAgentApiV1EndpointByOperation = Object.freeze(Object.fromEntries(
  f11AiAgentApiV1Endpoints.map((endpoint) => [endpoint.operation, endpoint])
) as { readonly [Endpoint in F11AiAgentApiV1Endpoint as Endpoint["operation"]]: Endpoint });
