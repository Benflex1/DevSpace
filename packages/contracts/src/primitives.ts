import { validateGitBranchShorthand, type GitBranchName } from "@devspace/domain";
import canonicalize from "canonicalize";
import * as z from "zod";

export const AGENT_API_VERSION = 1 as const;
export const AGENT_SOCKET_PATH = "/run/devspace/agent.sock" as const;
export const TERMINAL_SUBPROTOCOL = "devspace.terminal.v1" as const;
export const MUTATION_OPERATION_ID_HEADER = "X-DevSpace-Operation-Id" as const;
export const PROJECT_OPTIONS_REVISION_MAX_BYTES = 2_097_152 as const;

export const uuidV7Schema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
);
export type UuidV7 = z.infer<typeof uuidV7Schema>;

export const utcTimestampMsSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
).refine((value) => {
  const instant = new Date(value);
  return !Number.isNaN(instant.valueOf()) && instant.toISOString() === value;
}, "Timestamp must be a real canonical UTC millisecond instant");
export type UtcTimestampMs = z.infer<typeof utcTimestampMsSchema>;

export const projectOptionsRevisionHashSchema = z.string().regex(/^sha256-jcs-v1:[0-9a-f]{64}$/u);
export type ProjectOptionsRevisionHash = z.infer<typeof projectOptionsRevisionHashSchema>;

export const configurationKeySchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]{0,63}$/u);
export type ConfigurationKey = z.infer<typeof configurationKeySchema>;

export const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
export type GitObjectId = z.infer<typeof gitObjectIdSchema>;

export const gitBranchNameSchema = z.string().superRefine((value, context) => {
  const result = validateGitBranchShorthand(value);
  if (!result.ok) {
    context.addIssue({ code: "custom", message: result.error.code });
  }
}).transform((value) => value as GitBranchName);

export const gitBaseRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("branch"), branchName: gitBranchNameSchema }),
  z.strictObject({ kind: z.literal("commit"), commit: gitObjectIdSchema })
]);
export type GitBaseRef = z.infer<typeof gitBaseRefSchema>;

function containsControlOrWhitespace(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 32 || (codePoint >= 127 && codePoint <= 159));
  });
}

export const remoteRepositoryUrlSchema = z.string().superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 2048) {
    context.addIssue({ code: "custom", message: "URL must contain 1 through 2048 UTF-8 bytes" });
    return;
  }
  if (containsControlOrWhitespace(value)) {
    context.addIssue({ code: "custom", message: "URL contains control or whitespace characters" });
    return;
  }
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "ssh:") || url.hostname.length === 0) {
      context.addIssue({ code: "custom", message: "URL must be absolute HTTPS or SSH with a host" });
    }
    if (value.includes("#")) context.addIssue({ code: "custom", message: "URL fragments are forbidden" });
    const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/u)[0] ?? "";
    if (url.protocol === "https:" && (authority.includes("@") || url.username.length > 0 || url.password.length > 0)) {
      context.addIssue({ code: "custom", message: "HTTPS user-info is forbidden" });
    }
    const userInfo = authority.includes("@") ? authority.slice(0, authority.lastIndexOf("@")) : null;
    if (url.protocol === "ssh:" && (url.password.length > 0
      || userInfo?.includes(":") === true
      || (userInfo !== null && url.username.length === 0))) {
      context.addIssue({ code: "custom", message: "SSH user-info requires a username and forbids passwords" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "Malformed absolute repository URL" });
  }
});
export type RemoteRepositoryUrl = z.infer<typeof remoteRepositoryUrlSchema>;

export const canonicalJsonObjectTextSchema = z.string().superRefine((value, context) => {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength < 2 || byteLength > PROJECT_OPTIONS_REVISION_MAX_BYTES) {
    context.addIssue({ code: "custom", message: "Canonical JSON object has an invalid UTF-8 byte length" });
    return;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      context.addIssue({ code: "custom", message: "Canonical JSON root must be an object" });
      return;
    }
    const containsNonScalar = (candidate: unknown): boolean => {
      if (typeof candidate === "string") {
        return [...candidate].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff;
        });
      }
      if (Array.isArray(candidate)) return candidate.some(containsNonScalar);
      if (candidate !== null && typeof candidate === "object") {
        return Object.entries(candidate).some(([key, child]) => containsNonScalar(key) || containsNonScalar(child));
      }
      return false;
    };
    if (containsNonScalar(parsed)) {
      context.addIssue({ code: "custom", message: "Canonical JSON must contain only Unicode scalar values" });
      return;
    }
    if (canonicalize(parsed) !== value) {
      context.addIssue({ code: "custom", message: "JSON text is not its RFC 8785 canonical form" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "Malformed JSON text" });
  }
});
export type CanonicalJsonObjectText = z.infer<typeof canonicalJsonObjectTextSchema>;

export const errorMessageSchema = z.string().min(1).refine(
  (value) => ![...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31
      || (codePoint >= 127 && codePoint <= 159)
      || (codePoint >= 0xd800 && codePoint <= 0xdfff));
  }),
  "Error messages must not contain C0 or C1 controls"
).refine((value) => [...value].length <= 512, "Error messages contain at most 512 Unicode scalar values");
export const nonNegativeCountSchema = z.number().int().min(0).max(2_147_483_647);
export const exitCodeSchema = z.number().int().min(-2_147_483_648).max(2_147_483_647);

export const resourceTypeSchema = z.enum([
  "project", "workspace", "task-run", "process", "terminal", "preview", "ai-session"
]);
export const resourceReferenceSchema = z.strictObject({ type: resourceTypeSchema, id: uuidV7Schema });
export type ResourceReference = z.infer<typeof resourceReferenceSchema>;

export const commonRequestHeadersSchema = z.strictObject({
  "X-DevSpace-Protocol-Version": z.literal("1"),
  "X-DevSpace-Request-Id": uuidV7Schema,
  "X-DevSpace-Sent-At": utcTimestampMsSchema
});
export const mutationRequestHeadersSchema = commonRequestHeadersSchema.extend({
  [MUTATION_OPERATION_ID_HEADER]: uuidV7Schema
});
export type CommonRequestHeaders = z.infer<typeof commonRequestHeadersSchema>;
export type MutationRequestHeaders = z.infer<typeof mutationRequestHeadersSchema>;

export type RawHttpHeaders =
  | readonly (readonly [name: string, value: string])[]
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export type DevSpaceHeaderProjectionResult =
  | { readonly ok: true; readonly headers: Readonly<Record<string, string>> }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "UNKNOWN_DEVSPACE_HEADER" | "DUPLICATE_DEVSPACE_HEADER";
        readonly header: string;
      };
    };

const devSpaceHeaderCanonicalNames: ReadonlyMap<string, string> = new Map([
  ["x-devspace-protocol-version", "X-DevSpace-Protocol-Version"],
  ["x-devspace-request-id", "X-DevSpace-Request-Id"],
  ["x-devspace-sent-at", "X-DevSpace-Sent-At"],
  ["x-devspace-operation-id", MUTATION_OPERATION_ID_HEADER]
] as const);

export function extractDevSpaceProtocolHeaders(rawHeaders: RawHttpHeaders): DevSpaceHeaderProjectionResult {
  const entries: readonly (readonly [string, string | readonly string[] | undefined])[] = Array.isArray(rawHeaders)
    ? rawHeaders
    : Object.entries(rawHeaders);
  const projection: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const lowerName = rawName.toLowerCase();
    if (!lowerName.startsWith("x-devspace-")) continue;
    const canonicalName = devSpaceHeaderCanonicalNames.get(lowerName);
    if (canonicalName === undefined) {
      return { ok: false, error: { code: "UNKNOWN_DEVSPACE_HEADER", header: rawName } };
    }
    const values: readonly string[] = typeof rawValue === "string"
      ? [rawValue]
      : rawValue ?? [];
    if (values.length !== 1 || Object.hasOwn(projection, canonicalName)) {
      return { ok: false, error: { code: "DUPLICATE_DEVSPACE_HEADER", header: canonicalName } };
    }
    projection[canonicalName] = values[0]!;
  }
  return { ok: true, headers: Object.freeze(projection) };
}

export const responseMetaSchema = z.strictObject({
  protocolVersion: z.literal(AGENT_API_VERSION),
  requestId: uuidV7Schema,
  respondedAt: utcTimestampMsSchema
});
export const mutationReceiptSchema = z.strictObject({ operationId: uuidV7Schema });
export type MutationReceipt = z.infer<typeof mutationReceiptSchema>;

export function successEnvelopeSchema<Data extends z.ZodType>(data: Data) {
  return z.strictObject({ meta: responseMetaSchema, data });
}
export type SuccessEnvelopeSchema<Data extends z.ZodType> = z.ZodObject<{
  meta: typeof responseMetaSchema;
  data: Data;
}, z.core.$strict>;

export function postBodySchema<Data extends z.ZodType>(data: Data) {
  return z.strictObject({ data });
}
export type PostBodySchema<Data extends z.ZodType> = z.ZodObject<{ data: Data }, z.core.$strict>;
