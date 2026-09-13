import type {
  CodexCapabilitySet,
  CodexCompatibilityDiagnostic,
  CodexCompatibilityFeatureResult,
  CodexFeature
} from "@devspace/contracts";
import { resolveCodexSchemaReference } from "./schema-bundle.js";
import type {
  CodexCompatibilityEvaluation,
  CodexFeatureRequirement,
  CodexMethodRequirement,
  CodexSchemaBundle,
  JsonSchemaNode,
  SchemaPredicate
} from "./types.js";

export type { SchemaPredicate } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaTypes(schema: JsonSchemaNode): readonly string[] {
  const value = schema.type;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return [];
}

function propertySchema(schema: JsonSchemaNode, property: string): JsonSchemaNode | null {
  const properties = schema.properties;
  if (!isRecord(properties) || !isRecord(properties[property])) return null;
  return properties[property];
}

function requiredProperties(schema: JsonSchemaNode): readonly string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
}

function schemaVariants(schema: JsonSchemaNode): readonly JsonSchemaNode[] {
  const variants = [schema.oneOf, schema.anyOf].find(Array.isArray);
  if (variants === undefined) return [schema];
  return variants.filter(isRecord);
}

function matchesType(schema: JsonSchemaNode, types: readonly string[]): boolean {
  const actual = schemaTypes(schema);
  if (actual.length === 0) return false;
  return types.some((type) => actual.includes(type));
}

function satisfies(
  schema: JsonSchemaNode,
  predicate: SchemaPredicate,
  root: JsonSchemaNode,
  refs: readonly string[] = []
): boolean {
  if (typeof schema.$ref === "string") {
    if (refs.includes(schema.$ref)) return false;
    return satisfies(resolveCodexSchemaReference(root, schema), predicate, root, [...refs, schema.$ref]);
  }

  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    return schemaVariants(schema).some((variant) => satisfies(variant, predicate, root, refs));
  }

  switch (predicate.kind) {
    case "any":
      return true;
    case "type":
      return matchesType(schema, predicate.types);
    case "enum": {
      const values = schema.enum;
      if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) return false;
      if (!predicate.requiredValues.every((value) => values.includes(value))) return false;
      return predicate.allowAdditionalValues || values.every((value) => predicate.requiredValues.includes(value));
    }
    case "union": {
      const nullable = schemaTypes(schema).includes("null");
      if (predicate.nullable && !nullable) return false;
      if (!predicate.nullable && nullable && schemaTypes(schema).length === 1) return false;
      const nonNullSchema = nullable && schemaTypes(schema).length > 1
        ? { ...schema, type: schemaTypes(schema).filter((type) => type !== "null") }
        : schema;
      return predicate.alternatives.some((alternative) => satisfies(nonNullSchema, alternative, root, refs));
    }
    case "array": {
      if (!matchesType(schema, ["array"])) return false;
      const items = isRecord(schema.items) ? schema.items : null;
      if (items === null || !satisfies(items, predicate.items, root, refs)) return false;
      if (predicate.minItems !== undefined
        && (typeof schema.minItems !== "number" || schema.minItems < predicate.minItems)) return false;
      if (predicate.maxItems !== undefined
        && (typeof schema.maxItems !== "number" || schema.maxItems > predicate.maxItems)) return false;
      return true;
    }
    case "object": {
      if (!matchesType(schema, ["object"])) return false;
      const required = requiredProperties(schema);
      const properties = isRecord(schema.properties) ? schema.properties : {};
      for (const [name, childPredicate] of Object.entries(predicate.required)) {
        const child = propertySchema(schema, name);
        if (!required.includes(name) || child === null || !satisfies(child, childPredicate, root, refs)) return false;
      }
      for (const [name, childPredicate] of Object.entries(predicate.optional ?? {})) {
        const child = propertySchema(schema, name);
        if (child !== null && !satisfies(child, childPredicate, root, refs)) return false;
      }
      if (predicate.additionalProperties === "reject") {
        if (schema.additionalProperties !== false) return false;
      } else if (isRecord(predicate.additionalProperties)) {
        if (!isRecord(schema.additionalProperties)
          || !satisfies(schema.additionalProperties, predicate.additionalProperties, root, refs)) return false;
      }
      void properties;
      return true;
    }
  }
}

export function schemaSatisfiesPredicate(
  schema: JsonSchemaNode,
  predicate: SchemaPredicate
): boolean {
  return satisfies(schema, predicate, schema);
}

const stringType: SchemaPredicate = { kind: "type", types: ["string"] };
const integerOrNullType: SchemaPredicate = {
  kind: "union",
  alternatives: [{ kind: "type", types: ["integer"] }],
  nullable: true
};
const interactionBinding: SchemaPredicate = {
  kind: "object",
  required: {
    threadId: stringType,
    turnId: stringType
  },
  additionalProperties: "tolerate"
};
const approvalBinding: SchemaPredicate = {
  kind: "object",
  required: {
    threadId: stringType,
    turnId: stringType,
    itemId: stringType,
    startedAtMs: { kind: "type", types: ["integer", "number"] }
  },
  additionalProperties: "tolerate"
};
const resolvedBinding: SchemaPredicate = {
  kind: "object",
  required: {
    threadId: stringType,
    requestId: stringType
  },
  additionalProperties: "tolerate"
};
const basicSessionRequirements: CodexMethodRequirement[] = [
  { surface: "stable", direction: "request", method: "initialize", classification: "exact-semantic" },
  { surface: "stable", direction: "request", method: "thread/start", classification: "exact-semantic" },
  { surface: "stable", direction: "request", method: "turn/start", classification: "exact-semantic" },
  { surface: "stable", direction: "notification", method: "initialized", classification: "exact-semantic" },
  { surface: "stable", direction: "notification", method: "thread/started", classification: "type-compatible" },
  { surface: "stable", direction: "notification", method: "turn/started", classification: "type-compatible" },
  { surface: "stable", direction: "notification", method: "item/agentMessage/delta", classification: "type-compatible" },
  { surface: "stable", direction: "notification", method: "turn/completed", classification: "exact-semantic" }
];

const approvalRequirements: CodexMethodRequirement[] = [
  {
    surface: "stable",
    direction: "request",
    method: "item/commandExecution/requestApproval",
    params: approvalBinding,
    classification: "exact-semantic"
  },
  {
    surface: "stable",
    direction: "request",
    method: "item/fileChange/requestApproval",
    params: approvalBinding,
    classification: "exact-semantic"
  },
  {
    surface: "stable",
    direction: "notification",
    method: "serverRequest/resolved",
    params: resolvedBinding,
    classification: "exact-semantic"
  },
  {
    surface: "stable",
    direction: "notification",
    method: "item/started",
    params: interactionBinding,
    classification: "type-compatible"
  }
];

const structuredInputRequirements: CodexMethodRequirement[] = [
  {
    surface: "stable",
    direction: "request",
    method: "item/tool/requestUserInput",
    params: interactionBinding,
    classification: "exact-semantic"
  },
  {
    surface: "stable",
    direction: "notification",
    method: "serverRequest/resolved",
    params: resolvedBinding,
    classification: "exact-semantic"
  }
];

const interruptRequirements: CodexMethodRequirement[] = [
  { surface: "stable", direction: "request", method: "turn/interrupt", classification: "exact-semantic" },
  { surface: "stable", direction: "notification", method: "turn/completed", classification: "type-compatible" }
];

export const codexFeatureRequirements: readonly CodexFeatureRequirement[] = [
  { feature: "basicSession", required: true, methods: basicSessionRequirements },
  { feature: "approvals", required: true, methods: approvalRequirements },
  { feature: "structuredInput", required: false, methods: structuredInputRequirements },
  { feature: "interrupt", required: false, methods: interruptRequirements }
];

function methodCandidates(
  bundle: CodexSchemaBundle,
  requirement: CodexMethodRequirement
): readonly { schema: JsonSchemaNode; root: JsonSchemaNode }[] {
  const files = requirement.surface === "experimental" ? bundle.experimental : bundle.stable;
  const result: { schema: JsonSchemaNode; root: JsonSchemaNode }[] = [];
  for (const root of files.values()) {
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      if (!isRecord(node)) return;
      const properties = node.properties;
      const method = isRecord(properties) && isRecord(properties.method) ? properties.method.enum : undefined;
      if (Array.isArray(method) && method.includes(requirement.method)) result.push({ schema: node, root });
      for (const child of Object.values(node)) visit(child);
    };
    visit(root);
  }
  return result;
}

function methodSatisfies(bundle: CodexSchemaBundle, requirement: CodexMethodRequirement): boolean {
  const inventory = bundle.inventory[requirement.surface];
  const methods = requirement.direction === "request" ? inventory.requests
    : requirement.direction === "notification" ? inventory.notifications : inventory.responses;
  if (!methods.includes(requirement.method)) return false;
  if (requirement.params === undefined && requirement.result === undefined) return true;
  return methodCandidates(bundle, requirement).some(({ schema, root }) => {
    const params = propertySchema(schema, "params");
    const result = propertySchema(schema, "result");
    const paramsOk = requirement.params === undefined
      || (params !== null && satisfies(params, requirement.params, root));
    const resultOk = requirement.result === undefined
      || (result !== null && satisfies(result, requirement.result, root));
    return paramsOk && resultOk;
  });
}

function evaluateFeature(
  bundle: CodexSchemaBundle,
  requirement: CodexFeatureRequirement
): CodexCompatibilityFeatureResult {
  if (requirement.feature === "structuredInput") {
    const inputSchema = bundle.experimental.get("experimental/ToolRequestUserInputParams.json");
    if (inputSchema === undefined) {
      return { feature: requirement.feature, state: "missing", reason: "experimental-schema-missing" };
    }
    const inputShape: SchemaPredicate = {
      kind: "object",
      required: {
        itemId: stringType,
        threadId: stringType,
        turnId: stringType,
        questions: {
          kind: "array",
          items: {
            kind: "object",
            required: {
              header: stringType,
              id: stringType,
              question: stringType
            },
            optional: {
              options: {
                kind: "union",
                alternatives: [{ kind: "type", types: ["array"] }],
                nullable: true
              },
              isOther: { kind: "type", types: ["boolean"] },
              isSecret: { kind: "type", types: ["boolean"] }
            },
            additionalProperties: "tolerate"
          }
        }
      },
      additionalProperties: "tolerate"
    };
    const shapeOk = satisfies(inputSchema, inputShape, inputSchema);
    const methodsOk = requirement.methods.every((method) => methodSatisfies(bundle, method));
    return {
      feature: requirement.feature,
      state: shapeOk && methodsOk ? "supported" : "missing",
      reason: shapeOk && methodsOk ? null : "structured-input-shape-missing"
    };
  }

  const failed = requirement.methods.find((method) => !methodSatisfies(bundle, method));
  return {
    feature: requirement.feature,
    state: failed === undefined ? "supported" : requirement.required ? "incompatible" : "missing",
    reason: failed === undefined ? null : `${failed.method}-missing`
  };
}

function emptyFeatureResult(feature: CodexFeature, state: "missing" | "incompatible", reason: string): CodexCompatibilityFeatureResult {
  return { feature, state, reason };
}

export function evaluateCodexCompatibility(
  bundle: CodexSchemaBundle
): CodexCompatibilityEvaluation {
  const features = Object.fromEntries(codexFeatureRequirements.map((requirement) => [
    requirement.feature,
    evaluateFeature(bundle, requirement)
  ])) as Record<CodexFeature, CodexCompatibilityFeatureResult>;

  if (features.basicSession.state !== "supported") {
    features.approvals = emptyFeatureResult("approvals", "incompatible", "basic-session-missing");
    return {
      transport: "incompatible",
      features,
      capabilities: {
        inspect: true,
        start: true,
        resume: false,
        sendTurn: true,
        interrupt: false,
        approvals: false,
        structuredInput: false,
        stop: true,
        streamEvents: true
      },
      diagnostic: "CODEX_PROTOCOL_INCOMPATIBLE",
      stableSchemaFingerprint: bundle.stableFingerprint,
      experimentalSchemaFingerprint: bundle.experimentalFingerprint
    };
  }

  const approvals = features.approvals.state === "supported";
  const diagnostic: CodexCompatibilityDiagnostic | null = approvals
    ? null
    : "CODEX_APPROVAL_PROTOCOL_UNAVAILABLE";
  return {
    transport: "compatible",
    features,
    capabilities: {
      inspect: true,
      start: true,
      resume: bundle.inventory.stable.requests.includes("thread/resume"),
      sendTurn: true,
      interrupt: features.interrupt.state === "supported",
      approvals,
      structuredInput: features.structuredInput.state === "supported",
      stop: true,
      streamEvents: true
    },
    diagnostic,
    stableSchemaFingerprint: bundle.stableFingerprint,
    experimentalSchemaFingerprint: bundle.experimentalFingerprint
  };
}
