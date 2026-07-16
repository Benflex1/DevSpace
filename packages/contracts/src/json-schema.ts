import * as z from "zod";
import { eventCursorSchema, eventSequenceSchema } from "./cursor.js";
import {
  completeAgentApiV1ErrorCodes,
  completeAgentApiV1ErrorRegistry
} from "./errors.js";
import { agentEventSchema } from "./events.js";
import { completeAgentApiV1Endpoints } from "./f10-endpoints.js";
import {
  agentOperationObservationSchema,
  agentResourceReferenceSchema,
  agentSnapshotDataSchema,
  agentSnapshotResourceSchema
} from "./recovery.js";
import { agentExecutionFailureSchema } from "./execution-failures.js";

export type AgentApiV1JsonSchema = Record<string, unknown>;

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
}

export function generateAgentApiV1JsonSchema(): AgentApiV1JsonSchema {
  const definitions: Record<string, unknown> = Object.fromEntries(completeAgentApiV1ErrorCodes.map((code) => [
    `error.${code}.details`, jsonSchema(completeAgentApiV1ErrorRegistry[code].detailsSchema)
  ]));
  const eventCursorJsonSchema = jsonSchema(eventCursorSchema);
  eventCursorJsonSchema.description = "v1.<lowercase UUIDv7 agentBootId>.<sequence>; the exact sequence maximum 9007199254740991 is enforced by authoritative runtime validation.";
  eventCursorJsonSchema.$comment = "The portable decimal pattern enforces canonical spelling but does not encode the exact maximum safe integer. Runtime parseEventCursor enforces 0..9007199254740991.";
  Object.assign(definitions, {
    EventSequence: jsonSchema(eventSequenceSchema),
    EventCursor: eventCursorJsonSchema,
    AgentResourceReference: jsonSchema(agentResourceReferenceSchema),
    AgentExecutionFailure: jsonSchema(agentExecutionFailureSchema),
    AgentOperationObservation: jsonSchema(agentOperationObservationSchema),
    AgentSnapshotResource: jsonSchema(agentSnapshotResourceSchema),
    AgentSnapshotData: jsonSchema(agentSnapshotDataSchema),
    AgentEvent: jsonSchema(agentEventSchema)
  });
  const operations = Object.fromEntries(completeAgentApiV1Endpoints.map((endpoint) => [
    endpoint.operation, (() => {
      const prefix = `operation.${endpoint.operation}`;
      definitions[`${prefix}.headers`] = jsonSchema(endpoint.headersSchema);
      definitions[`${prefix}.pathParameters`] = jsonSchema(endpoint.pathParametersSchema);
      const hasQuery = !endpoint.querySchema.safeParse(undefined).success;
      const successContentType = "successContentType" in endpoint
        ? endpoint.successContentType
        : endpoint.successStatus === 101 ? null : "application/json";
      const responseKind = "responseKind" in endpoint
        ? endpoint.responseKind
        : endpoint.successStatus === 101 ? "websocket-upgrade" : "json-envelope";
      if (hasQuery) definitions[`${prefix}.query`] = jsonSchema(endpoint.querySchema);
      definitions[`${prefix}.errors`] = jsonSchema(endpoint.errorSchema);
      if (endpoint.method === "POST") definitions[`${prefix}.requestBody`] = jsonSchema(endpoint.requestBodySchema);
      if (endpoint.successBodySchema !== null) definitions[`${prefix}.successBody`] = jsonSchema(endpoint.successBodySchema);
      return {
        method: endpoint.method,
        path: endpoint.path,
        classification: endpoint.classification,
        requiredDevSpaceHeaders: endpoint.requiredDevSpaceHeaders,
        successStatus: endpoint.successStatus,
        successContentType,
        responseKind,
        errorsAfterSuccessBegins: "errorsAfterSuccessBegins" in endpoint
          ? endpoint.errorsAfterSuccessBegins
          : false,
        headers: { $ref: `#/$defs/${prefix}.headers` },
        pathParameters: { $ref: `#/$defs/${prefix}.pathParameters` },
        query: hasQuery ? { $ref: `#/$defs/${prefix}.query` } : false,
        requestBody: endpoint.method === "GET" ? false : { $ref: `#/$defs/${prefix}.requestBody` },
        successBody: endpoint.successBodySchema === null ? false : { $ref: `#/$defs/${prefix}.successBody` },
        errorSchema: { $ref: `#/$defs/${prefix}.errors` },
        errors: endpoint.errors.map((error) => ({
          code: error.code,
          statuses: error.statuses
        }))
      };
    })()
  ]));

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://devspace.local/schemas/agent-api-v1.schema.json",
    title: "DevSpace Agent API v1 executable contracts",
    description: "Structural JSON Schema projection of the complete DevSpace Agent API v1 F09 and F10 wire contracts.",
    $comment: "Authoritative runtime Zod validation additionally enforces semantic refinements including cursor/event equality, snapshot boot/cursor equality, resource and operation uniqueness, lifecycle structural edges, process observation semantics, and project Git-scope consistency. EventCursor's exact maximum 9007199254740991 is enforced by runtime parseEventCursor; its portable decimal string pattern does not fully encode that upper bound. The preview.state.changed event schema validates all invariants available from the wire object, but retained-observation transition semantics require validatePreviewObservationChange with the prior full preview observation; standalone JSON Schema and standalone agentEventSchema cannot prove those absent-context invariants. JSON Schema does not prove event-stream continuity, replay availability, snapshot atomicity, or retention behavior; see packages/contracts/README.md.",
    $defs: definitions,
    "x-devspace-protocol-version": 1,
    "x-devspace-endpoint-count": completeAgentApiV1Endpoints.length,
    "x-devspace-operations": operations
  };
}
