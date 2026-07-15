import * as z from "zod";
import { agentApiV1Endpoints } from "./endpoints.js";
import { executableAgentErrorCodes, executableAgentErrorRegistry } from "./errors.js";

export type AgentApiV1JsonSchema = Record<string, unknown>;

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
}

export function generateAgentApiV1JsonSchema(): AgentApiV1JsonSchema {
  const definitions: Record<string, unknown> = Object.fromEntries(executableAgentErrorCodes.map((code) => [
    `error.${code}.details`, jsonSchema(executableAgentErrorRegistry[code].detailsSchema)
  ]));
  const operations = Object.fromEntries(agentApiV1Endpoints.map((endpoint) => [
    endpoint.operation, (() => {
      const prefix = `operation.${endpoint.operation}`;
      definitions[`${prefix}.headers`] = jsonSchema(endpoint.headersSchema);
      definitions[`${prefix}.pathParameters`] = jsonSchema(endpoint.pathParametersSchema);
      definitions[`${prefix}.errors`] = jsonSchema(endpoint.errorSchema);
      if (endpoint.method === "POST") definitions[`${prefix}.requestBody`] = jsonSchema(endpoint.requestBodySchema);
      if (endpoint.successBodySchema !== null) definitions[`${prefix}.successBody`] = jsonSchema(endpoint.successBodySchema);
      return {
        method: endpoint.method,
        path: endpoint.path,
        classification: endpoint.classification,
        requiredDevSpaceHeaders: endpoint.requiredDevSpaceHeaders,
        successStatus: endpoint.successStatus,
        headers: { $ref: `#/$defs/${prefix}.headers` },
        pathParameters: { $ref: `#/$defs/${prefix}.pathParameters` },
        query: false,
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
    title: "DevSpace Agent API v1 executable F09 contracts",
    description: "Structural JSON Schema projection of the DevSpace Agent API v1 F09 wire contract.",
    $comment: "Authoritative runtime Zod validation additionally enforces documented semantic refinements that JSON Schema generation cannot faithfully represent; see packages/contracts/README.md.",
    $defs: definitions,
    "x-devspace-protocol-version": 1,
    "x-devspace-endpoint-count": agentApiV1Endpoints.length,
    "x-devspace-operations": operations
  };
}
