import serverNotificationSchemaJson from "../../../../packages/contracts/fixtures/codex-app-server/0.145.0/stable/ServerNotification.json" with { type: "json" };

type JsonSchema = Readonly<Record<string, unknown>>;
export type CodexNotificationCategory =
  | "projected-and-handled"
  | "private-lifecycle"
  | "validated-and-ignored";
export type CodexNotificationClassification = CodexNotificationCategory | "unknown-non-blocking";

const projectedAndHandled = [
  "item/agentMessage/delta",
  "item/started",
  "serverRequest/resolved"
] as const;

const privateLifecycle = [
  "error",
  "turn/started",
  "turn/completed"
] as const;

const validatedAndIgnored = [
  "thread/started",
  "thread/status/changed",
  "thread/archived",
  "thread/deleted",
  "thread/unarchived",
  "thread/closed",
  "skills/changed",
  "thread/name/updated",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/settings/updated",
  "thread/tokenUsage/updated",
  "hook/started",
  "hook/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "item/completed",
  "item/plan/delta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "process/exited",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "account/rateLimits/updated",
  "app/list/updated",
  "remoteControl/status/changed",
  "externalAgentConfig/import/progress",
  "externalAgentConfig/import/completed",
  "fs/changed",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "thread/compacted",
  "model/rerouted",
  "model/verification",
  "turn/moderationMetadata",
  "model/safetyBuffering/updated",
  "warning",
  "guardianWarning",
  "deprecationNotice",
  "configWarning",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
  "account/login/completed"
] as const;

function categoryEntries(methods: readonly string[], category: CodexNotificationCategory): Array<readonly [string, CodexNotificationCategory]> {
  return methods.map((method) => [method, category] as const);
}

export const CODEX_NOTIFICATION_CATEGORY_REGISTRY: Readonly<Record<string, CodexNotificationCategory>> = Object.freeze(Object.fromEntries([
  ...categoryEntries(projectedAndHandled, "projected-and-handled"),
  ...categoryEntries(privateLifecycle, "private-lifecycle"),
  ...categoryEntries(validatedAndIgnored, "validated-and-ignored")
]));

const rootSchema = serverNotificationSchemaJson as unknown as JsonSchema;
const notificationSchemas = new Map<string, JsonSchema>();
for (const candidate of rootSchema.oneOf as readonly JsonSchema[]) {
  const properties = candidate.properties as JsonSchema;
  const methodSchema = properties.method as JsonSchema;
  const method = (methodSchema.enum as readonly unknown[])[0];
  if (typeof method === "string") notificationSchemas.set(method, candidate);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function schemaRecord(value: unknown): JsonSchema | null {
  return objectRecord(value);
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "object") return objectRecord(value) !== null;
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return type === "integer" && typeof value === "number" && Number.isSafeInteger(value);
}

function resolveSchema(schema: JsonSchema): JsonSchema | null {
  const reference = schema.$ref;
  if (typeof reference !== "string") return schema;
  const prefix = "#/definitions/";
  if (!reference.startsWith(prefix)) return null;
  return schemaRecord((rootSchema.definitions as JsonSchema)[reference.slice(prefix.length)]);
}

function matchesSchema(value: unknown, initialSchema: JsonSchema, depth = 0): boolean {
  if (depth > 64) return false;
  const schema = resolveSchema(initialSchema);
  if (schema === null) return false;
  const oneOf = schema.oneOf as readonly JsonSchema[] | undefined;
  if (oneOf !== undefined && oneOf.filter((candidate) => matchesSchema(value, candidate, depth + 1)).length !== 1) return false;
  const anyOf = schema.anyOf as readonly JsonSchema[] | undefined;
  if (anyOf !== undefined && !anyOf.some((candidate) => matchesSchema(value, candidate, depth + 1))) return false;
  const allOf = schema.allOf as readonly JsonSchema[] | undefined;
  if (allOf !== undefined && !allOf.every((candidate) => matchesSchema(value, candidate, depth + 1))) return false;

  const enumeration = schema.enum as readonly unknown[] | undefined;
  if (enumeration !== undefined && !enumeration.some((candidate) => Object.is(candidate, value))) return false;
  const declaredTypes = typeof schema.type === "string" ? [schema.type]
    : Array.isArray(schema.type) ? schema.type.filter((candidate): candidate is string => typeof candidate === "string") : [];
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => matchesType(value, type))) return false;

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- pattern is repository-pinned Codex 0.145.0 schema data.
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return false;
  }
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) return false;
  if (Array.isArray(value)) {
    const itemSchema = schemaRecord(schema.items);
    if (itemSchema !== null && !value.every((item) => matchesSchema(item, itemSchema, depth + 1))) return false;
  }
  const record = objectRecord(value);
  if (record !== null) {
    const required = schema.required as readonly unknown[] | undefined;
    if (required !== undefined && required.some((key) => typeof key !== "string" || !Object.prototype.hasOwnProperty.call(record, key))) return false;
    const properties = schemaRecord(schema.properties) ?? {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      const nested = schemaRecord(propertySchema);
      if (nested !== null && Object.prototype.hasOwnProperty.call(record, key) && !matchesSchema(record[key], nested, depth + 1)) return false;
    }
    for (const [key, nestedValue] of Object.entries(record)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      if (schema.additionalProperties === false) return false;
      const additional = schemaRecord(schema.additionalProperties);
      if (additional !== null && !matchesSchema(nestedValue, additional, depth + 1)) return false;
    }
  }
  return true;
}

export function validateCodexNotification(notification: Readonly<Record<string, unknown>>): CodexNotificationCategory | null {
  const method = notification.method;
  if (typeof method !== "string") return null;
  const category = CODEX_NOTIFICATION_CATEGORY_REGISTRY[method];
  const schema = notificationSchemas.get(method);
  if (category === undefined || schema === undefined || !matchesSchema(notification, schema)) return null;
  return category;
}

export function classifyCodexNotification(notification: Readonly<Record<string, unknown>>): CodexNotificationClassification | null {
  const method = notification.method;
  const params = notification.params;
  if (typeof method !== "string" || params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const known = validateCodexNotification(notification);
  if (known !== null) return known;
  return CODEX_NOTIFICATION_CATEGORY_REGISTRY[method] === undefined ? "unknown-non-blocking" : null;
}
