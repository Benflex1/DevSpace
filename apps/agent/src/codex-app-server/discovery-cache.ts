import path from "node:path";
import * as z from "zod";
import {
  codexCompatibilityDiagnostics,
  type CodexCapabilitySet,
  type CodexCompatibilityDiagnostic,
  type CodexCompatibilityFeatureResult,
  type CodexFeature,
  type CodexProbeRuntimeIdentity
} from "@devspace/contracts";
import { durableJsonWriter, readRegularFileNoFollow, type AtomicJsonWriter } from "../private-state.js";

const MAX_CACHE_BYTES = 256 * 1024;
const closureDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const featureSchema = z.strictObject({
  feature: z.enum(["basicSession", "approvals", "structuredInput", "interrupt"]),
  state: z.enum(["supported", "missing", "incompatible"]),
  reason: z.string().max(128).nullable()
});
const featureResultsSchema = z.strictObject({
  basicSession: featureSchema,
  approvals: featureSchema,
  structuredInput: featureSchema,
  interrupt: featureSchema
});
const capabilitySchema = z.strictObject({
  inspect: z.boolean(), start: z.boolean(), resume: z.boolean(), sendTurn: z.boolean(), interrupt: z.boolean(),
  approvals: z.boolean(), structuredInput: z.boolean(), stop: z.boolean(), streamEvents: z.boolean()
});
const runtimeSchema = z.strictObject({
  imageId: z.string().regex(/^sha256:[0-9a-f]{32,}$/u), operatingSystem: z.string().min(1).max(32),
  architecture: z.string().min(1).max(32), containerUser: z.string().max(128), policyVersion: z.literal("codex-probe-runtime-v1")
});
const cacheKeySchema = z.strictObject({
  closureDigest: closureDigestSchema, probeRuntimeIdentity: runtimeSchema,
  schemaCommandContract: z.literal("codex-app-server-schema-v1"), cacheFormat: z.literal("codex-discovery-cache-v1"),
  semanticAdapterVersion: z.string().min(1).max(128), compatibilityPolicyVersion: z.string().min(1).max(128)
});
const cacheValueSchema = z.strictObject({
  key: cacheKeySchema, reportedVersion: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u),
  stableSchemaFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  experimentalSchemaFingerprint: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  featureResults: featureResultsSchema, capabilities: capabilitySchema,
  diagnostic: z.enum(codexCompatibilityDiagnostics).nullable()
});

export interface CodexDiscoveryCacheKey {
  readonly closureDigest: string;
  readonly probeRuntimeIdentity: CodexProbeRuntimeIdentity;
  readonly schemaCommandContract: "codex-app-server-schema-v1";
  readonly cacheFormat: "codex-discovery-cache-v1";
  readonly semanticAdapterVersion: string;
  readonly compatibilityPolicyVersion: string;
}

export interface CodexDiscoveryCacheValue {
  readonly key: CodexDiscoveryCacheKey;
  readonly reportedVersion: string;
  readonly stableSchemaFingerprint: string;
  readonly experimentalSchemaFingerprint: string | null;
  readonly featureResults: Readonly<Record<CodexFeature, CodexCompatibilityFeatureResult>>;
  readonly capabilities: CodexCapabilitySet;
  readonly diagnostic: CodexCompatibilityDiagnostic | null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("codex-cache-canonicalization-failed");
}

function cacheKeysEqual(left: CodexDiscoveryCacheKey, right: CodexDiscoveryCacheKey): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class CodexDiscoveryCache {
  private readonly root: string;
  constructor(stateRoot: string, private readonly writer: AtomicJsonWriter = durableJsonWriter) {
    this.root = path.join(path.resolve(stateRoot), "ai", "codex-discovery-cache");
  }

  pathFor(key: CodexDiscoveryCacheKey): string {
    if (!closureDigestSchema.safeParse(key.closureDigest).success) throw new Error("codex-cache-key-invalid");
    return path.join(this.root, `${key.closureDigest}.json`);
  }

  async read(key: CodexDiscoveryCacheKey): Promise<CodexDiscoveryCacheValue | null> {
    let parsed: unknown;
    try {
      const { bytes } = await readRegularFileNoFollow(this.pathFor(key), MAX_CACHE_BYTES);
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
    const checked = cacheValueSchema.safeParse(parsed);
    if (!checked.success || !cacheKeysEqual(checked.data.key, key)) return null;
    return checked.data as CodexDiscoveryCacheValue;
  }

  async write(value: CodexDiscoveryCacheValue): Promise<void> {
    const checked = cacheValueSchema.parse(value);
    await this.writer.write(this.pathFor(checked.key), checked);
  }
}

export const CODEX_DISCOVERY_CACHE_MAX_BYTES = MAX_CACHE_BYTES;
