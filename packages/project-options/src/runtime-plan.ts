import { createHash } from "node:crypto";
import * as z from "zod";
import { canonicalizeJsonBytes } from "./canonical-json.js";
import { parseProjectOptionsV1 } from "./parser.js";

const environmentNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/u);
const imageReferenceSchema = z.string().min(1).max(512).refine(
  (value) => ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  }),
  "RUNTIME_PLAN_INVALID_IMAGE_REFERENCE"
).regex(/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/u, "RUNTIME_PLAN_INVALID_IMAGE_REFERENCE")
  .refine((value) => !value.includes("://"), "RUNTIME_PLAN_INVALID_IMAGE_REFERENCE");

export const runtimePlanV1Schema = z.strictObject({
  format: z.literal("devspace.runtime-plan/v1"),
  developmentContainer: z.strictObject({
    source: z.strictObject({ kind: z.literal("image"), imageReference: imageReferenceSchema }),
    containerUser: z.string().min(1).nullable(),
    workingDirectory: z.literal("/workspace"),
    environment: z.record(environmentNameSchema, z.string()),
    ports: z.array(z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9-]*$/u),
      containerPort: z.number().int().min(1).max(65535),
      protocol: z.literal("tcp")
    })),
    resources: z.strictObject({
      cpuMillicores: z.number().int().positive().nullable(),
      memoryBytes: z.number().int().positive().nullable(),
      pidLimit: z.number().int().positive().nullable()
    })
  }),
  services: z.tuple([]),
  namedVolumes: z.tuple([]),
  setupSteps: z.tuple([]),
  passwordlessSudo: z.literal(false)
});

export type RuntimePlanV1 = z.infer<typeof runtimePlanV1Schema>;

export type RuntimePlanUnsupportedReason =
  | "source-preset"
  | "source-dockerfile"
  | "supporting-services"
  | "named-volumes"
  | "development-volume-mounts"
  | "setup-steps"
  | "unresolved-environment-binding"
  | "passwordless-sudo";

export class RuntimePlanCompilationError extends Error {
  readonly code = "RUNTIME_PLAN_UNSUPPORTED" as const;
  constructor(readonly reason: RuntimePlanUnsupportedReason) {
    super(`Project Options cannot be executed by runtime-plan v1: ${reason}.`);
    this.name = "RuntimePlanCompilationError";
  }
}

function unsupported(reason: RuntimePlanUnsupportedReason): never {
  throw new RuntimePlanCompilationError(reason);
}

export function compileRuntimePlanV1(input: unknown): RuntimePlanV1 {
  const options = parseProjectOptionsV1(input);
  const development = options.developmentEnvironment;
  if (development.source.kind === "preset") unsupported("source-preset");
  if (development.source.kind === "dockerfile") unsupported("source-dockerfile");
  if (options.services.length !== 0) unsupported("supporting-services");
  if (options.namedVolumes.length !== 0) unsupported("named-volumes");
  if (development.volumes.length !== 0) unsupported("development-volume-mounts");
  if (development.setupSteps.length !== 0) unsupported("setup-steps");
  if (development.passwordlessSudo) unsupported("passwordless-sudo");
  const environment: Record<string, string> = {};
  for (const [name, binding] of Object.entries(development.environment)) {
    if (binding.kind !== "literal") unsupported("unresolved-environment-binding");
    environment[name] = binding.value;
  }
  return runtimePlanV1Schema.parse({
    format: "devspace.runtime-plan/v1",
    developmentContainer: {
      source: development.source,
      containerUser: development.containerUser,
      workingDirectory: development.workingDirectory,
      environment,
      ports: [...development.ports].sort((left, right) =>
        left.name.localeCompare(right.name) || left.containerPort - right.containerPort),
      resources: {
        cpuMillicores: options.resources.cpuMillicores,
        memoryBytes: options.resources.memoryBytes,
        pidLimit: options.resources.pidLimit
      }
    },
    services: [], namedVolumes: [], setupSteps: [], passwordlessSudo: false
  });
}

export function parseRuntimePlanV1(input: unknown): RuntimePlanV1 {
  return runtimePlanV1Schema.parse(input);
}

function canonicalBytes(input: unknown): Uint8Array {
  return canonicalizeJsonBytes(parseRuntimePlanV1(input));
}

export function canonicalizeRuntimePlanV1(input: unknown): string {
  return new TextDecoder().decode(canonicalBytes(input));
}

const runtimePlanHashDomain = new TextEncoder().encode("devspace/runtime-plan/v1");
declare const runtimePlanHashBrand: unique symbol;
export type RuntimePlanHash = string & { readonly [runtimePlanHashBrand]: "RuntimePlanHash" };

export function hashRuntimePlanV1(input: unknown): RuntimePlanHash {
  const hash = createHash("sha256");
  hash.update(runtimePlanHashDomain);
  hash.update(Uint8Array.of(0));
  hash.update(canonicalBytes(input));
  return `sha256-jcs-v1:${hash.digest("hex")}` as RuntimePlanHash;
}
