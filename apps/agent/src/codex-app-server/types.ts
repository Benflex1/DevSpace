import type {
  CodexCapabilitySet,
  CodexCompatibilityDiagnostic,
  CodexCompatibilityFeatureResult,
  CodexFeature,
  CodexSurface
} from "@devspace/contracts";

export type JsonSchemaNode = Readonly<Record<string, unknown>>;

export interface CodexSurfaceMethodInventory {
  readonly requests: readonly string[];
  readonly responses: readonly string[];
  readonly notifications: readonly string[];
}

export interface CodexSchemaBundle {
  readonly stable: ReadonlyMap<string, JsonSchemaNode>;
  readonly experimental: ReadonlyMap<string, JsonSchemaNode>;
  readonly inventory: Readonly<{
    readonly stable: CodexSurfaceMethodInventory;
    readonly experimental: CodexSurfaceMethodInventory;
  }>;
  readonly methodSchemas: ReadonlyMap<string, readonly JsonSchemaNode[]>;
  readonly byteLength: number;
  readonly stableFingerprint: string;
  readonly experimentalFingerprint: string;
}

export type SchemaPredicate =
  | {
      readonly kind: "type";
      readonly types: readonly ("object" | "array" | "string" | "number" | "integer" | "boolean" | "null")[];
    }
  | {
      readonly kind: "object";
      readonly required: Readonly<Record<string, SchemaPredicate>>;
      readonly optional?: Readonly<Record<string, SchemaPredicate>>;
      readonly additionalProperties: "tolerate" | "reject" | SchemaPredicate;
    }
  | {
      readonly kind: "array";
      readonly items: SchemaPredicate;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  | {
      readonly kind: "union";
      readonly alternatives: readonly SchemaPredicate[];
      readonly nullable: boolean;
    }
  | {
      readonly kind: "enum";
      readonly requiredValues: readonly string[];
      readonly allowAdditionalValues: boolean;
    }
  | { readonly kind: "any" };

export interface CodexMethodRequirement {
  readonly surface: CodexSurface;
  readonly direction: "request" | "response" | "notification";
  readonly method: string;
  readonly params?: SchemaPredicate;
  readonly result?: SchemaPredicate;
  readonly classification:
    | "exact-semantic"
    | "type-compatible"
    | "optional-evidence"
    | "ignored-private";
}

export interface CodexFeatureRequirement {
  readonly feature: CodexFeature;
  readonly required: boolean;
  readonly methods: readonly CodexMethodRequirement[];
}

export interface CodexCompatibilityEvaluation {
  readonly transport: "compatible" | "incompatible";
  readonly features: Readonly<Record<CodexFeature, CodexCompatibilityFeatureResult>>;
  readonly capabilities: CodexCapabilitySet;
  readonly diagnostic: CodexCompatibilityDiagnostic | null;
  readonly stableSchemaFingerprint: string;
  readonly experimentalSchemaFingerprint: string | null;
}
