import { createHash } from "node:crypto";
import {
  canonicalizeJsonBytes,
  type JsonValue
} from "./canonical-json.js";
import { parseProjectOptionsV1 } from "./parser.js";
import type { ProjectOptionsV1 } from "./schema.js";

const projectOptionsRevisionDomain = "devspace/project-options-revision/v1";
const projectOptionsRevisionDomainBytes = new TextEncoder().encode(projectOptionsRevisionDomain);
export const PROJECT_OPTIONS_REVISION_MAX_BYTES = 2_097_152 as const;

export class ProjectOptionsRevisionSizeError extends RangeError {
  readonly code = "PROJECT_OPTIONS_REVISION_TOO_LARGE" as const;

  constructor(
    readonly actualBytes: number,
    readonly maximumBytes: number = PROJECT_OPTIONS_REVISION_MAX_BYTES
  ) {
    super(`Canonical Project Options revision is ${actualBytes} bytes; maximum is ${maximumBytes}`);
    this.name = "ProjectOptionsRevisionSizeError";
  }
}

declare const projectOptionsRevisionHashBrand: unique symbol;
export type ProjectOptionsRevisionHash = string & {
  readonly [projectOptionsRevisionHashBrand]: "ProjectOptionsRevisionHash";
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

function comparePair(
  leftFirst: string,
  leftSecond: string,
  rightFirst: string,
  rightSecond: string
): number {
  return compareText(leftFirst, rightFirst) || compareText(leftSecond, rightSecond);
}

function normalizeCommand(command: ProjectOptionsV1["tasks"][number]["command"]): typeof command {
  return { ...command, args: [...command.args], environment: { ...command.environment } };
}

function normalizeProjectOptionsV1(parsed: ProjectOptionsV1): ProjectOptionsV1 {
  return {
    ...parsed,
    namedVolumes: [...parsed.namedVolumes].sort((left, right) => compareText(left.key, right.key)),
    developmentEnvironment: {
      ...parsed.developmentEnvironment,
      environment: { ...parsed.developmentEnvironment.environment },
      ports: [...parsed.developmentEnvironment.ports].sort((left, right) =>
        compareText(left.name, right.name) || compareNumber(left.containerPort, right.containerPort)
      ),
      volumes: [...parsed.developmentEnvironment.volumes].sort((left, right) =>
        comparePair(left.volumeKey, left.mountPath, right.volumeKey, right.mountPath)
      ),
      setupSteps: parsed.developmentEnvironment.setupSteps.map(normalizeCommand)
    },
    tasks: [...parsed.tasks]
      .sort((left, right) => compareText(left.key, right.key))
      .map((task) => ({
        ...task,
        command: normalizeCommand(task.command),
        successExitCodes: [...task.successExitCodes].sort(compareNumber)
      })),
    services: [...parsed.services]
      .sort((left, right) => compareText(left.key, right.key))
      .map((service) => ({
        ...service,
        environment: { ...service.environment },
        volumes: [...service.volumes].sort((left, right) =>
          comparePair(left.volumeKey, left.mountPath, right.volumeKey, right.mountPath)
        ),
        ports: [...service.ports].sort((left, right) =>
          compareText(left.name, right.name) || compareNumber(left.containerPort, right.containerPort)
        ),
        entrypoint: service.entrypoint === null ? null : [...service.entrypoint],
        command: service.command === null ? null : [...service.command],
        healthCheck: service.healthCheck === null
          ? null
          : service.healthCheck.kind === "http"
            ? {
                ...service.healthCheck,
                expectedStatuses: [...service.healthCheck.expectedStatuses].sort(compareNumber)
              }
            : service.healthCheck.kind === "command"
              ? { ...service.healthCheck, command: normalizeCommand(service.healthCheck.command) }
              : { ...service.healthCheck },
        dependsOn: [...service.dependsOn].sort((left, right) =>
          compareText(left.serviceKey, right.serviceKey)
        ),
        resources: { ...service.resources }
      })),
    previews: [...parsed.previews]
      .sort((left, right) => compareText(left.key, right.key))
      .map((preview) => ({
        ...preview,
        target: { ...preview.target },
        healthStatuses: [...preview.healthStatuses].sort(compareNumber)
      })),
    aiProfile: parsed.aiProfile === null
      ? null
      : {
          ...parsed.aiProfile,
          fixedArgs: [...parsed.aiProfile.fixedArgs],
          credentialSecretIds: [...parsed.aiProfile.credentialSecretIds].sort(compareText)
        },
    resources: { ...parsed.resources }
  };
}

function normalizedJson(input: unknown): JsonValue {
  return normalizeProjectOptionsV1(parseProjectOptionsV1(input));
}

function canonicalRevisionBytes(input: unknown): Uint8Array {
  const bytes = canonicalizeJsonBytes(normalizedJson(input));
  if (bytes.byteLength > PROJECT_OPTIONS_REVISION_MAX_BYTES) {
    throw new ProjectOptionsRevisionSizeError(bytes.byteLength);
  }
  return bytes;
}

export function canonicalizeProjectOptionsV1(input: unknown): string {
  return new TextDecoder().decode(canonicalRevisionBytes(input));
}

export function canonicalizeProjectOptionsV1Bytes(input: unknown): Uint8Array {
  return canonicalRevisionBytes(input);
}

export function hashProjectOptionsV1(input: unknown): ProjectOptionsRevisionHash {
  const canonicalBytes = canonicalizeProjectOptionsV1Bytes(input);
  const hash = createHash("sha256");
  hash.update(projectOptionsRevisionDomainBytes);
  hash.update(Uint8Array.of(0));
  hash.update(canonicalBytes);
  return `sha256-jcs-v1:${hash.digest("hex")}` as ProjectOptionsRevisionHash;
}
