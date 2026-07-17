import http from "node:http";
import {
  AGENT_API_VERSION,
  agentApiV1EndpointByOperation,
  type HealthData,
  type SourceInspectionData
} from "@devspace/contracts";
import { v7 as uuidv7 } from "uuid";

const MAX_RESPONSE_BYTES = 256 * 1024;
export class AgentUnavailableError extends Error {
  constructor() { super("The DevSpace Agent is unavailable."); this.name = "AgentUnavailableError"; }
}
export class AgentResponseError extends Error {
  readonly code: string;
  constructor(code: string) { super("The Agent could not inspect this repository."); this.name = "AgentResponseError"; this.code = code; }
}

export function createAgentClient(socketPath: string, options: { timeoutMs?: number; createId?: () => string; now?: () => Date } = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const createId = options.createId ?? uuidv7;
  const now = options.now ?? (() => new Date());

  async function call(operation: "agent.health.get" | "project.source.inspect", data?: unknown): Promise<unknown> {
    const endpoint = agentApiV1EndpointByOperation[operation];
    const requestId = createId();
    const body = data === undefined ? undefined : JSON.stringify(endpoint.requestBodySchema.parse({ data }));
    return await new Promise((resolve, reject) => {
      const request = http.request({
        socketPath,
        path: endpoint.path,
        method: endpoint.method,
        headers: {
          "X-DevSpace-Protocol-Version": String(AGENT_API_VERSION),
          "X-DevSpace-Request-Id": requestId,
          "X-DevSpace-Sent-At": now().toISOString(),
          Accept: "application/json",
          ...(body === undefined ? {} : {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(body)
          })
        }
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) request.destroy(new AgentUnavailableError());
          else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (response.statusCode === endpoint.successStatus) {
              return resolve(endpoint.successBodySchema.parse(parsed).data);
            }
            const error = endpoint.errorSchema.parse(parsed) as { error: { code: string } };
            return reject(new AgentResponseError(error.error.code));
          } catch {
            return reject(new AgentUnavailableError());
          }
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new AgentUnavailableError()));
      request.on("error", (error) => reject(error instanceof AgentUnavailableError ? error : new AgentUnavailableError()));
      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  return {
    health: async (): Promise<HealthData> => await call("agent.health.get") as HealthData,
    inspectSource: async (url: string): Promise<SourceInspectionData> => await call(
      "project.source.inspect", { source: { kind: "remote", url } }
    ) as SourceInspectionData
  };
}

export type AgentClient = ReturnType<typeof createAgentClient>;
