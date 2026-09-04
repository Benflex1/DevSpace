import * as z from "zod";
import { eventCursorSchema } from "./cursor.js";
import { nonAiAgentApiV1Endpoints } from "./endpoints.js";
import { f11AiAgentApiV1Endpoints } from "./f11-ai-endpoints.js";
import { githubAgentApiV1Endpoints } from "./github-app-endpoints.js";
import {
  buildAgentErrorEnvelopeSchema,
  completeAgentApiV1ErrorRegistry,
  type CompleteAgentApiV1ErrorCode
} from "./errors.js";
import { AGENT_EVENT_NDJSON_CONTENT_TYPE } from "./events.js";
import {
  commonRequestHeadersSchema,
  successEnvelopeSchema
} from "./primitives.js";
import { agentSnapshotDataSchema } from "./recovery.js";

const noPathParametersSchema = z.strictObject({});
const noQuerySchema = z.undefined();
const noBodySchema = z.undefined();
const eventStreamQuerySchema = z.strictObject({ cursor: eventCursorSchema });

function errors(codes: readonly CompleteAgentApiV1ErrorCode[]) {
  return Object.freeze(codes.map((code) => Object.freeze({
    code,
    statuses: completeAgentApiV1ErrorRegistry[code].statuses,
    schema: buildAgentErrorEnvelopeSchema(code)
  })));
}

const snapshotErrors = errors([
  "PROTOCOL_VERSION_UNSUPPORTED",
  "REQUEST_INVALID",
  "AGENT_INTERNAL_ERROR"
]);
const streamErrors = errors([
  "PROTOCOL_VERSION_UNSUPPORTED",
  "EVENT_CURSOR_INVALID",
  "REQUEST_INVALID",
  "EVENT_SNAPSHOT_REQUIRED",
  "AGENT_INTERNAL_ERROR"
]);

export const f10AgentApiV1Endpoints = Object.freeze([
  Object.freeze({
    operation: "snapshot.get",
    method: "GET",
    path: "/v1/snapshot" as const,
    classification: "non-mutating",
    journaledMutation: false,
    requiredDevSpaceHeaders: Object.freeze([
      "X-DevSpace-Protocol-Version", "X-DevSpace-Request-Id", "X-DevSpace-Sent-At"
    ]),
    headersSchema: commonRequestHeadersSchema,
    pathParametersSchema: noPathParametersSchema,
    querySchema: noQuerySchema,
    requestBodySchema: noBodySchema,
    requestDataSchema: null,
    successStatus: 200 as const,
    successBodySchema: successEnvelopeSchema(agentSnapshotDataSchema),
    successDataSchema: agentSnapshotDataSchema,
    successContentType: "application/json" as const,
    responseKind: "json-envelope" as const,
    errorsAfterSuccessBegins: false,
    errors: snapshotErrors,
    errorSchema: z.union(snapshotErrors.map((error) => error.schema) as unknown as [z.ZodType, z.ZodType])
  }),
  Object.freeze({
    operation: "event.stream",
    method: "GET",
    path: "/v1/events" as const,
    classification: "non-mutating",
    journaledMutation: false,
    requiredDevSpaceHeaders: Object.freeze([
      "X-DevSpace-Protocol-Version", "X-DevSpace-Request-Id", "X-DevSpace-Sent-At"
    ]),
    headersSchema: commonRequestHeadersSchema,
    pathParametersSchema: noPathParametersSchema,
    querySchema: eventStreamQuerySchema,
    requestBodySchema: noBodySchema,
    requestDataSchema: null,
    successStatus: 200 as const,
    successBodySchema: null,
    successDataSchema: null,
    successContentType: AGENT_EVENT_NDJSON_CONTENT_TYPE,
    responseKind: "ndjson-stream" as const,
    errorsAfterSuccessBegins: false,
    errors: streamErrors,
    errorSchema: z.union(streamErrors.map((error) => error.schema) as unknown as [z.ZodType, z.ZodType])
  })
] as const);

export type F10AgentApiV1Endpoint = (typeof f10AgentApiV1Endpoints)[number];
export type F10AgentApiV1Operation = F10AgentApiV1Endpoint["operation"];
export const f10AgentApiV1EndpointByOperation = Object.freeze(Object.fromEntries(
  f10AgentApiV1Endpoints.map((descriptor) => [descriptor.operation, descriptor])
) as { readonly [Endpoint in F10AgentApiV1Endpoint as Endpoint["operation"]]: Endpoint });

export const completeAgentApiV1Endpoints = Object.freeze([
  ...nonAiAgentApiV1Endpoints,
  ...f10AgentApiV1Endpoints,
  ...f11AiAgentApiV1Endpoints,
  ...githubAgentApiV1Endpoints
]);
export type CompleteAgentApiV1Endpoint = (typeof completeAgentApiV1Endpoints)[number];
export const completeAgentApiV1EndpointByOperation = Object.freeze(Object.fromEntries(
  completeAgentApiV1Endpoints.map((descriptor) => [descriptor.operation, descriptor])
) as { readonly [Endpoint in CompleteAgentApiV1Endpoint as Endpoint["operation"]]: Endpoint });
