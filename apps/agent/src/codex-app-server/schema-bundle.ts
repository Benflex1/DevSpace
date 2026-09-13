import { createHash } from "node:crypto";
import type {
  CodexSchemaBundle,
  CodexSurfaceMethodInventory,
  JsonSchemaNode
} from "./types.js";

export type { CodexSchemaBundle } from "./types.js";

const MAX_SCHEMA_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SCHEMA_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_SCHEMA_FILES = 32;
const SCHEMA_FILE_PATTERN = /^(stable|experimental)\/(ClientRequest|ClientNotification|ServerRequest|ServerNotification|[A-Za-z0-9_-]+)\.json$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSchema(bytes: Uint8Array, file: string): JsonSchemaNode {
  if (bytes.byteLength > MAX_SCHEMA_FILE_BYTES) {
    throw new Error(`schema-file-too-large:${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error(`schema-invalid-json:${file}`);
  }
  if (!isRecord(parsed)) throw new Error(`schema-root-not-object:${file}`);
  return parsed;
}

function decodePointerSegment(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function localReference(root: JsonSchemaNode, reference: string): JsonSchemaNode {
  if (!reference.startsWith("#/")) throw new Error(`external-reference:${reference}`);
  const parts = reference.slice(2).split("/").map(decodePointerSegment);
  const [containerName, definitionName] = parts;
  if (containerName === undefined || definitionName === undefined
    || parts.length !== 2 || !["definitions", "$defs"].includes(containerName)) {
    throw new Error(`unsupported-reference:${reference}`);
  }
  const container = root[containerName];
  if (!isRecord(container) || !isRecord(container[definitionName])) {
    throw new Error(`unresolved-reference:${reference}`);
  }
  return container[definitionName];
}

function validateReferences(node: unknown, root: JsonSchemaNode, stack: readonly string[] = []): void {
  if (Array.isArray(node)) {
    for (const child of node) validateReferences(child, root, stack);
    return;
  }
  if (!isRecord(node)) return;
  if (typeof node.$ref === "string") {
    const reference = node.$ref;
    if (stack.includes(reference)) throw new Error(`reference-cycle:${reference}`);
    validateReferences(localReference(root, reference), root, [...stack, reference]);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== "$ref") validateReferences(value, root, stack);
  }
}

function methodNames(node: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) methodNames(child, result);
    return result;
  }
  if (!isRecord(node)) return result;
  const properties = node.properties;
  if (isRecord(properties) && isRecord(properties.method)) {
    const values = properties.method.enum;
    if (Array.isArray(values)) {
      for (const value of values) if (typeof value === "string") result.add(value);
    }
  }
  for (const value of Object.values(node)) methodNames(value, result);
  return result;
}

function methodNodes(node: unknown, method: string, result: JsonSchemaNode[] = []): JsonSchemaNode[] {
  if (Array.isArray(node)) {
    for (const child of node) methodNodes(child, method, result);
    return result;
  }
  if (!isRecord(node)) return result;
  const properties = node.properties;
  if (isRecord(properties) && isRecord(properties.method)) {
    const values = properties.method.enum;
    if (Array.isArray(values) && values.includes(method)) result.push(node);
  }
  for (const value of Object.values(node)) methodNodes(value, method, result);
  return result;
}

function surfaceInventory(
  files: ReadonlyMap<string, JsonSchemaNode>
): CodexSurfaceMethodInventory {
  const requests = new Set<string>();
  const responses = new Set<string>();
  const notifications = new Set<string>();
  for (const [file, schema] of files) {
    const names = methodNames(schema);
    if (file.includes("Request")) for (const name of names) requests.add(name);
    else if (file.includes("Notification")) for (const name of names) notifications.add(name);
    else if (file.includes("Response")) for (const name of names) responses.add(name);
  }
  return {
    requests: [...requests].sort(),
    responses: [...responses].sort(),
    notifications: [...notifications].sort()
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("schema-canonicalization-failed");
  return serialized;
}

function fingerprint(files: ReadonlyMap<string, JsonSchemaNode>): string {
  const value = Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function loadCodexSchemaBundle(
  input: ReadonlyMap<string, Uint8Array>
): CodexSchemaBundle {
  if (input.size === 0 || input.size > MAX_SCHEMA_FILES) throw new Error("schema-file-count-invalid");
  let byteLength = 0;
  const stable = new Map<string, JsonSchemaNode>();
  const experimental = new Map<string, JsonSchemaNode>();
  for (const [file, bytes] of input) {
    if (!SCHEMA_FILE_PATTERN.test(file)) throw new Error(`schema-file-name-invalid:${file}`);
    byteLength += bytes.byteLength;
    if (byteLength > MAX_SCHEMA_BUNDLE_BYTES) throw new Error("schema-bundle-too-large");
    const schema = parseSchema(bytes, file);
    validateReferences(schema, schema);
    (file.startsWith("experimental/") ? experimental : stable).set(file, schema);
  }

  const inventory = {
    stable: surfaceInventory(stable),
    experimental: surfaceInventory(experimental)
  } as const;
  const methodSchemas = new Map<string, JsonSchemaNode[]>();
  for (const schema of [...stable.values(), ...experimental.values()]) {
    for (const method of methodNames(schema)) {
      const matches = methodNodes(schema, method);
      const existing = methodSchemas.get(method) ?? [];
      existing.push(...matches);
      methodSchemas.set(method, existing);
    }
  }

  return {
    stable,
    experimental,
    inventory,
    methodSchemas,
    byteLength,
    stableFingerprint: fingerprint(stable),
    experimentalFingerprint: fingerprint(experimental)
  };
}

export function resolveCodexSchemaReference(
  root: JsonSchemaNode,
  schema: JsonSchemaNode
): JsonSchemaNode {
  if (typeof schema.$ref !== "string") return schema;
  return localReference(root, schema.$ref);
}
