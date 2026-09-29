import type { CodexArtifactLayout } from "@devspace/contracts";
import { DockerEngineError, DockerEngineTransportError } from "../docker-runtime.js";

export const codexArtifactStagingPhases = [
  "artifact-resolution",
  "agent-side-stage-copy",
  "readback-helper-load",
  "readback-helper-integrity",
  "staged-artifact-verification",
  "readback-helper-upload",
  "artifact-entry-upload",
  "artifact-entry-readback",
  "final-closure-verification",
  "failure-cleanup"
] as const;

export type CodexArtifactStagingPhase = (typeof codexArtifactStagingPhases)[number];

export interface CodexArtifactStagingDiagnostic {
  readonly phase: CodexArtifactStagingPhase;
  readonly failureCode: string;
  readonly errorClass: string;
  readonly containerId: string;
  readonly artifactLayout: CodexArtifactLayout | "unknown";
  readonly entryRelative?: string;
  readonly elapsedMs: number;
  readonly cleanupElapsedMs?: number;
}

function safeElapsed(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(600_000, Math.round(value)));
}

function classifyFailure(error: unknown): { failureCode: string; errorClass: string } {
  if (error instanceof DockerEngineError) {
    return {
      failureCode: Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
        ? `docker-http-${error.statusCode}` : "docker-http-error",
      errorClass: "DockerEngineError"
    };
  }
  if (error instanceof DockerEngineTransportError) {
    return { failureCode: "docker-transport", errorClass: "DockerEngineTransportError" };
  }
  if (!(error instanceof Error)) return { failureCode: "unclassified", errorClass: "UnknownError" };

  const nodeCode = (error as NodeJS.ErrnoException).code;
  if (typeof nodeCode === "string" && /^[A-Z][A-Z0-9_]{0,31}$/u.test(nodeCode)) {
    return { failureCode: `node-${nodeCode.toLowerCase()}`, errorClass: "SystemError" };
  }
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,95}$/u.test(error.message)) {
    return { failureCode: error.message, errorClass: error.name === "TypeError" || error.name === "RangeError"
      || error.name === "SyntaxError" || error.name === "AbortError" ? error.name : "Error" };
  }
  return { failureCode: "unclassified", errorClass: "Error" };
}

function boundedEntryRelative(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 240 || value.startsWith("/")) return undefined;
  const components = value.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === ".."
    || !/^[A-Za-z0-9._@+-]+$/u.test(component))) return undefined;
  return value;
}

export function codexArtifactStagingDiagnostic(input: {
  readonly phase: CodexArtifactStagingPhase;
  readonly error: unknown;
  readonly containerId: string;
  readonly artifactLayout: CodexArtifactLayout | "unknown";
  readonly entryRelative?: string;
  readonly elapsedMs: number;
  readonly cleanupElapsedMs?: number;
}): CodexArtifactStagingDiagnostic {
  const failure = classifyFailure(input.error);
  const entryRelative = boundedEntryRelative(input.entryRelative);
  return {
    phase: input.phase,
    ...failure,
    containerId: /^[a-f0-9]{12,64}$/u.test(input.containerId) ? input.containerId : "unknown",
    artifactLayout: input.artifactLayout,
    ...(entryRelative === undefined ? {} : { entryRelative }),
    elapsedMs: safeElapsed(input.elapsedMs),
    ...(input.cleanupElapsedMs === undefined ? {} : { cleanupElapsedMs: safeElapsed(input.cleanupElapsedMs) })
  };
}
