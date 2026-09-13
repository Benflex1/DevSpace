# Codex Version Compatibility Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:executing-plans for sequential execution of this plan. Use one Luna Max implementation agent unless a genuinely independent bounded task requires a Luna High or Luna Max subagent. This plan is intentionally sequential because provider authority, artifact identity, probing, and runtime state are coupled.

**Goal:** Replace the production-only Codex 0.145 executable allowlist with a protocol-family compatibility path that accepts Codex 0.145.0 and newer compatible releases while preserving the Checkpoint 2 interaction, session, and Workbench guarantees.

**Architecture:** The Agent resolves a recognized Codex execution-artifact closure, stages and hashes that exact closure, probes it inside a dedicated isolated container based on the exact image used by the managed workspace, and caches bounded compatibility evidence by closure identity. A deterministic structural evaluator admits feature capabilities, while a stable DevSpace semantic adapter continues to own redaction, provider-private IDs, interaction lifecycle, file-change correlation, one-shot responses, and teardown. The same staged closure and image identity are proved again before managed provider launch.

**Tech Stack:** TypeScript, Node 24, Docker Engine API through the existing rootless runtime client, Zod, canonical JSON, JSON-RPC over bounded stdio, Drizzle/better-sqlite3, Vitest, and Playwright.

**Spec:** docs/superpowers/specs/2026-09-13-codex-version-compatibility-design.md

## Global Constraints

- Minimum supported Codex version is 0.145.0; there is no upper version bound and no release-number allowlist.
- Version numbers are a minimum gate and diagnostic only; protocol structure, semantic invariants, and effective capabilities decide compatibility.
- 0.145.0 remains the exact baseline fixture and regression corpus, not the only authorized executable.
- Provider code is never executed with Agent-host privileges. Version and schema probes run in an isolated Docker container with no network, workspace, credentials, Agent socket, Docker socket, or unrelated host mounts.
- The execution-artifact closure staged for probing is the only closure admitted for provider launch. A mutable configured path is never reread after staging.
- Recognized execution forms are the official standalone package, the official npm/pnpm/bun native payload layout, and a compatible self-contained native executable. Arbitrary shell/JavaScript launchers and unresolved shims fail closed.
- Generated schemas are bounded structural evidence only. The stable DevSpace semantic adapter remains authoritative for safety, redaction, workspace paths, provider-private IDs, interaction lifecycle, and response encoding.
- Command and file approvals are required for the current writable managed Codex profile, with approvalPolicy on-request and approvalsReviewer user. Missing approval semantics make the profile unavailable.
- structuredInput and interrupt may degrade independently only when their absence cannot create an unhandled blocking request.
- An unknown blocking JSON-RPC server request is terminal: retire or fence pending interactions, terminate the exact provider generation, transition through the existing safe lost/failed lifecycle, and expose only a bounded diagnostic.
- Browser/Web state contains only DevSpace-owned IDs and safe presentations. Native provider IDs, native labels, raw diffs, schemas, executable details, and private diagnostics remain Agent-private.
- Existing sessions remain pinned to their stored profile revision. A changed executable closure or effective protocol authority creates a new profile revision; old sessions remain history and are never silently resumed under new bytes.
- Web remains the sole SQLite writer. No database capability cache is added merely for convenience; current Agent profile discovery is the capability authority.
- The one-live-Codex/provider lease remains authoritative. A repeated Create request reuses a current nonterminal session, historical stopped/lost sessions do not block a new current-profile session, and another live profile is rejected clearly.
- Keep the four approval decisions, structured multi-question validation, secret-input rejection, canonical interaction projection, ambiguity reconciliation, stream generation guards, changed-file Workbench routing, and all existing stop/restart/reconnect behavior.
- Do not add providers, model selection, chat management, branch management, project creation, Git identity settings, checkpoint/rollback, automatic downloads, or a second diff/editor implementation.
- Every implementation task follows RED → focused GREEN → one self-check → coherent commit. Use Luna-family models only; use no Terra, Sol, Astra, Gemini, or other model family.
- Perform one focused authority review after the provider-boundary integration and one final integrated review. Do not create a review cascade or repeatedly re-review unchanged code.

## Target File Structure

The current 0.145 implementation is concentrated in apps/agent/src/ai-session-runtime.ts,
apps/agent/src/codex-interactions-v0-145.ts, and
apps/agent/src/codex-notification-schema-v0-145.ts. Extract provider-family responsibilities
into focused modules while leaving ai-session-runtime.ts responsible for session, turn, outbox,
and process-generation state:

    packages/contracts/src/provider-adapters/codex-app-server.ts
    packages/contracts/src/provider-adapters/codex-app-server.test.ts
    packages/contracts/src/provider-adapters/codex-app-server-baseline-fixture.ts
    packages/contracts/src/provider-adapters/codex-app-server-baseline-fixture.test.ts

    apps/agent/src/codex-app-server/types.ts
    apps/agent/src/codex-app-server/artifact-identity.ts
    apps/agent/src/codex-app-server/artifact-identity.test.ts
    apps/agent/src/codex-app-server/schema-bundle.ts
    apps/agent/src/codex-app-server/schema-compatibility.ts
    apps/agent/src/codex-app-server/schema-compatibility.test.ts
    apps/agent/src/codex-app-server/probe-runtime.ts
    apps/agent/src/codex-app-server/probe-runtime.test.ts
    apps/agent/src/codex-app-server/discovery-cache.ts
    apps/agent/src/codex-app-server/discovery-cache.test.ts
    apps/agent/src/codex-app-server/discovery.ts
    apps/agent/src/codex-app-server/discovery.test.ts
    apps/agent/src/codex-app-server/profile-authority.ts
    apps/agent/src/codex-app-server/profile-authority.test.ts
    apps/agent/src/codex-app-server/transport.ts
    apps/agent/src/codex-app-server/transport.test.ts
    apps/agent/src/codex-app-server/interactions.ts
    apps/agent/src/codex-app-server/interactions.test.ts
    apps/agent/src/codex-app-server/notifications.ts
    apps/agent/src/codex-app-server/notifications.test.ts
    apps/agent/src/codex-app-server/artifact-stager.ts
    apps/agent/src/codex-app-server/artifact-stager.test.ts
    apps/agent/src/codex-app-server/provider.ts

The existing fixture directory remains under
packages/contracts/fixtures/codex-app-server/0.145.0. A checked-in newer fixture is added
under packages/contracts/fixtures/codex-app-server/0.153.4 when captured through the isolated
probe path. Synthetic additive, breaking, missing-optional-capability, and approval-incompatible
cases remain deterministic in evaluator tests and do not require a runtime Codex installation.

## Task 1: Introduce version-independent contracts and migrate 0.145 naming to baseline fixtures

**Files:**

- Create: packages/contracts/src/provider-adapters/codex-app-server.ts
- Create: packages/contracts/src/provider-adapters/codex-app-server.test.ts
- Rename: packages/contracts/src/provider-adapters/codex-app-server-v0-145.ts to packages/contracts/src/provider-adapters/codex-app-server-baseline-fixture.ts
- Rename: packages/contracts/src/provider-adapters/codex-app-server-v0-145.test.ts to packages/contracts/src/provider-adapters/codex-app-server-baseline-fixture.test.ts
- Modify: packages/contracts/src/provider-adapters/ai-profile-revision-v1.ts
- Modify: packages/contracts/src/provider-adapters/ai-profile-revision-v1.test.ts
- Modify: packages/contracts/src/ai-sessions.ts
- Modify: packages/contracts/src/ai-sessions.test.ts
- Modify: packages/contracts/src/index.ts
- Modify: packages/contracts/fixtures/codex-app-server/0.145.0/protocol-manifest.json

**Interfaces produced:**

    export const CODEX_MINIMUM_SUPPORTED_VERSION = "0.145.0" as const;
    export const CODEX_SEMANTIC_ADAPTER_VERSION = "codex-app-server-family-v1" as const;
    export const CODEX_COMPATIBILITY_POLICY_VERSION = "codex-compatibility-v1" as const;

    export type CodexSurface = "stable" | "experimental";
    export type CodexFeature =
      | "basicSession"
      | "approvals"
      | "structuredInput"
      | "interrupt";

    export type CodexCapabilitySet = Readonly<{
      inspect: true;
      start: true;
      resume: boolean;
      sendTurn: true;
      interrupt: boolean;
      approvals: boolean;
      structuredInput: boolean;
      stop: true;
      streamEvents: true;
    }>;

    export type CodexCompatibilityDiagnostic =
      | "CODEX_VERSION_BELOW_MINIMUM"
      | "CODEX_UNRECOGNIZED_EXECUTION_FORM"
      | "CODEX_EXECUTABLE_INTEGRITY_CHANGED"
      | "CODEX_PROTOCOL_INCOMPATIBLE"
      | "CODEX_APPROVAL_PROTOCOL_UNAVAILABLE"
      | "CODEX_UNKNOWN_BLOCKING_REQUEST";

    export type CodexCompatibilityFeatureResult = Readonly<{
      feature: CodexFeature;
      state: "supported" | "missing" | "incompatible";
      reason: string | null;
    }>;

    export const codexProtocolFixtureManifestSchema = z.strictObject({
      baselineVersion: z.string(),
      cliVersion: z.string(),
      versionOutput: z.string(),
      generatedAt: z.string(),
      stableGenerationCommand: z.literal("codex app-server generate-json-schema"),
      experimentalGenerationCommand: z.literal("codex app-server generate-json-schema --experimental"),
      transport: z.strictObject({
        mode: z.literal("stdio-jsonl"),
        tty: z.literal(false),
        stdout: z.literal("protocol-only"),
        stderr: z.literal("private-diagnostics")
      }),
      officialSource: z.string().url(),
      upstreamLicense: z.literal("Apache-2.0"),
      fixtures: z.array(z.strictObject({
        scope: z.enum(["stable", "experimental"]),
        file: z.string().min(1),
        bytes: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/u)
      })).max(16),
      methods: z.record(z.string(), z.array(z.string()).max(128)).optional()
    });

The manifest schema must accept baseline version, stable and experimental schema files,
transport mode, bounded method inventory, and SHA-256/byte-count metadata. It must not expose
native request IDs, raw schema contents, executable bytes, or private diagnostics through browser
contracts. Extend the existing profile authority document with explicit authority fields for
executionArtifactClosureDigest, executionArtifactLayout, protocolSchemaFingerprint,
probeRuntimeIdentity, experimentalApi, approvalPolicy, and approvalsReviewer. Keep the existing
sha256-ai-profile-v1 revision string format so SQLite rows remain valid; the expanded canonical
authority document changes the digest when an effective authority input changes.

Add availability diagnostics for minimum-version, artifact-form, integrity, protocol, and
required-approval failures. Add CODEX_UNKNOWN_BLOCKING_REQUEST to the safe session-loss
diagnostic union used by canonical events; never add a raw provider message field.

**Interfaces consumed:**

- Existing aiProviderCapabilitiesSchema, aiProviderProfileProjectionSchema,
  canonicalAiEventSchema, and AI profile authority hashing.
- The exact 0.145 fixture manifest and five existing fixture files.

- [ ] **Step 1: Write failing contract tests.** Preserve the existing 0.145 fixture hash,
  method inventory, experimental-surface, and private-launch tests under the baseline fixture
  name. Add tests proving a newer version is representable, the minimum is 0.145.0, additive
  capability evidence is expressible, approval absence is a required-profile failure, and
  profile hashing changes for closure digest, protocol fingerprint, probe image identity,
  experimental opt-in, approval policy, and reviewer.

    const authority = Object.assign({}, baselineAuthority, {
      providerVersion: "0.153.4",
      executableIdentity: "sha256-entrypoint",
      executionArtifactClosureDigest: "sha256-closure",
      executionArtifactLayout: "standalone-package",
      protocolSchemaFingerprint: "sha256-schema",
      probeRuntimeIdentity: { imageId: "sha256-image", os: "linux", architecture: "amd64" },
      experimentalApi: true,
      approvalPolicy: "on-request",
      approvalsReviewer: "user"
    });
    expect(hashAiProviderAuthorityV1(authority)).not.toBe(hashAiProviderAuthorityV1(baselineAuthority));

- [ ] **Step 2: Run focused tests to verify RED.**

    pnpm exec vitest run packages/contracts/src/provider-adapters/codex-app-server.test.ts packages/contracts/src/provider-adapters/ai-profile-revision-v1.test.ts packages/contracts/src/ai-sessions.test.ts

- [ ] **Step 3: Implement the generic contract and baseline rename.** Move the current
  v0-145 manifest schema and protocol-method constants into the baseline-fixture module,
  replace production exports with generic minimum/policy/adapter constants, update the root
  contract index, and extend strict authority/event/availability schemas. Keep literal 0.145
  values only in the baseline fixture manifest and its tests.

- [ ] **Step 4: Run GREEN.**

    pnpm exec vitest run packages/contracts/src/provider-adapters/codex-app-server.test.ts packages/contracts/src/provider-adapters/codex-app-server-baseline-fixture.test.ts packages/contracts/src/provider-adapters/ai-profile-revision-v1.test.ts packages/contracts/src/ai-sessions.test.ts

- [ ] **Step 5: Self-check and commit.**

    rg -n "codex-app-server-v0-145|CODEX_APP_SERVER_CLI_VERSION" packages/contracts apps/agent
    git diff --check
    git add packages/contracts
    git commit -m "refactor: define version-independent Codex contracts"

## Task 2: Build the deterministic structural compatibility evaluator

**Files:**

- Create: apps/agent/src/codex-app-server/types.ts
- Create: apps/agent/src/codex-app-server/schema-bundle.ts
- Create: apps/agent/src/codex-app-server/schema-compatibility.ts
- Create: apps/agent/src/codex-app-server/schema-compatibility.test.ts
- Modify: packages/contracts/fixtures/codex-app-server/0.145.0/protocol-manifest.json

**Interfaces produced:**

    export type JsonSchemaNode = Readonly<Record<string, unknown>>;

    export interface CodexSchemaBundle {
      readonly stable: ReadonlyMap<string, JsonSchemaNode>;
      readonly experimental: ReadonlyMap<string, JsonSchemaNode>;
      readonly inventory: Readonly<{
        readonly stable: CodexSurfaceMethodInventory;
        readonly experimental: CodexSurfaceMethodInventory;
      }>;
      readonly byteLength: number;
      readonly stableFingerprint: string;
      readonly experimentalFingerprint: string;
    }

    export interface CodexSurfaceMethodInventory {
      readonly requests: readonly string[];
      readonly responses: readonly string[];
      readonly notifications: readonly string[];
    }

    export type SchemaPredicate =
      | { readonly kind: "type"; readonly types: readonly ("object" | "array" | "string" | "number" | "integer" | "boolean" | "null")[] }
      | {
          readonly kind: "object";
          readonly required: Readonly<Record<string, SchemaPredicate>>;
          readonly optional?: Readonly<Record<string, SchemaPredicate>>;
          readonly additionalProperties: "tolerate" | "reject" | SchemaPredicate;
        }
      | { readonly kind: "array"; readonly items: SchemaPredicate; readonly minItems?: number; readonly maxItems?: number }
      | { readonly kind: "union"; readonly alternatives: readonly SchemaPredicate[]; readonly nullable: boolean }
      | { readonly kind: "enum"; readonly requiredValues: readonly string[]; readonly allowAdditionalValues: boolean }
      | { readonly kind: "any" };

    export interface CodexMethodRequirement {
      readonly surface: "stable" | "experimental";
      readonly direction: "request" | "response" | "notification";
      readonly method: string;
      readonly params?: SchemaPredicate;
      readonly result?: SchemaPredicate;
      readonly classification: "exact-semantic" | "type-compatible" | "optional-evidence" | "ignored-private";
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

    export function loadCodexSchemaBundle(input: ReadonlyMap<string, Uint8Array>): CodexSchemaBundle;
    export function evaluateCodexCompatibility(bundle: CodexSchemaBundle): CodexCompatibilityEvaluation;

The loader accepts only expected generated filenames, caps each document at 8 MiB and the
total bundle at 32 MiB, rejects invalid JSON and external references, and resolves only local
definitions and $defs. It retains a visited-reference set and depth limit; a reference cycle
cannot satisfy a predicate. Fingerprints are canonicalized evidence only.

The loader derives a method inventory from each bounded document and rejects duplicate method
definitions or an unrecognized direction. The evaluator uses exact required properties, optional
properties as evidence only, and the predicate's explicit additionalProperties policy: required
semantic objects tolerate additive unknown fields only when the predicate says tolerate; a
field whose extra values could change a required semantic is rejected. It evaluates array items
and classified bounds, oneOf/anyOf, nullable type arrays such as type ["string", "null"], and
required enum subset matching. allowAdditionalValues applies only to new enum members in the
discovered schema; an unknown enum value received at runtime is still rejected by the semantic
adapter. Stable versus experimental method inventories are evaluated separately, and the four
feature requirements from the approved design are explicit predicates. The feature requirements
name initialize/initialized, thread/start, turn/start, assistant delta, turn completion, both
approval requests, correlated fileChange item data, serverRequest/resolved, experimental user
input, autoResolutionMs, non-empty options, isOther, non-secret semantics, and interrupt
terminal correlation. Approval incompatibility is a provider failure, not optional degradation.

The evaluator never infers redaction, workspace-relative paths, safe commands, approval intent,
or provider-private identity from a JSON Schema scalar type.

**Interfaces consumed:**

- Generic feature and diagnostic types from Task 1.
- The five exact 0.145 generated JSON fixtures.

- [ ] **Step 1: Write failing evaluator tests.** Cover bounded loading, external and unresolved
  references, nested definitions, reference cycles, required/optional fields, arrays, nullable
  unions, oneOf/anyOf, additive object properties, additive enum values, missing required
  methods, stable/experimental separation, all feature outcomes, and approval incompatibility.

    const additive = withSchemaChange(baseline, (schema) => {
      schema.properties.newOptionalField = { type: "string" };
      schema.additionalProperties = true;
    });
    expect(evaluateCodexCompatibility(loadBundle(additive)).features.basicSession.state)
      .toBe("supported");

- [ ] **Step 2: Run RED.**

    pnpm exec vitest run apps/agent/src/codex-app-server/schema-compatibility.test.ts

- [ ] **Step 3: Implement bounded schema loading, local-reference resolution, recursive
  predicates, method inventories, enum subset handling, and feature capability projection.**
  Return private reason codes without copying provider descriptions or raw schema text into
  diagnostics.

- [ ] **Step 4: Run GREEN.**

    pnpm exec vitest run apps/agent/src/codex-app-server/schema-compatibility.test.ts

- [ ] **Step 5: Self-check and commit.**

    rg -n "schemaFingerprint ===|raw schema|provider description" apps/agent/src/codex-app-server
    git diff --check
    git add apps/agent/src/codex-app-server packages/contracts/fixtures/codex-app-server/0.145.0/protocol-manifest.json
    git commit -m "feat: add structural Codex compatibility evaluation"

## Task 3: Recognize and stage the exact Codex execution-artifact closure

**Files:**

- Create: apps/agent/src/codex-app-server/artifact-identity.ts
- Create: apps/agent/src/codex-app-server/artifact-identity.test.ts
- Modify: apps/agent/src/private-state.ts
- Modify: apps/agent/src/managed-workspaces.ts

**Interfaces produced:**

    export type CodexArtifactLayout =
      | "standalone-package"
      | "official-node-native-payload"
      | "self-contained-native";

    export interface CodexArtifactEntry {
      readonly relativePath: string;
      readonly kind: "file" | "symlink";
      readonly mode: number;
      readonly linkTarget: string | null;
      readonly byteLength: number;
      readonly sha256: string | null;
    }

    export interface CodexExecutionArtifact {
      readonly configuredPath: string;
      readonly canonicalSourceRoot: string;
      readonly layout: CodexArtifactLayout;
      readonly target: { readonly os: string; readonly architecture: string; readonly abi: string };
      readonly packageVersion: string | null;
      readonly entrypoint: CodexArtifactEntry;
      readonly entries: readonly CodexArtifactEntry[];
      readonly entrypointSha256: string;
      readonly closureDigest: string;
    }

    export interface StagedCodexExecutionArtifact {
      readonly artifact: CodexExecutionArtifact;
      readonly stagingRoot: string;
      readonly entrypointPath: string;
      readonly readbackManifestPath: string;
    }

    export function resolveCodexExecutionArtifact(configuredPath: string): Promise<CodexExecutionArtifact>;
    export function stageCodexExecutionArtifact(input: {
      readonly artifact: CodexExecutionArtifact;
      readonly stateRoot: string;
    }): Promise<StagedCodexExecutionArtifact>;
    export function verifyStagedCodexExecutionArtifact(staged: StagedCodexExecutionArtifact): Promise<void>;

The resolver uses no-follow descriptor reads and existing private-state identity checks. It
hashes exact regular-file bytes and includes sorted relative path, kind, mode, link target,
byte length, and per-file SHA-256 in the closure digest. The configured pathname is private
diagnostic data and is not itself the identity hash.

Recognize these forms without executing package code:

1. Official standalone package: codex-package.json, bin/codex, codex-resources, codex-path,
   native helper layout, release target, and safe convenience link.
2. Official npm/pnpm/bun installation: statically parse the recognized @openai/codex metadata
   and platform relationship, resolve vendor/<target>/bin/codex, and include its native
   package closure. Never execute bin/codex.js or package-manager hooks.
3. Direct self-contained native executable: accept a one-file closure only when the fixed probe
   runtime can execute its target/ABI and protocol discovery succeeds.

Reject arbitrary shell or JavaScript launchers, unresolved shims, devices, unexpected links,
traversal, ambiguous optional dependency resolution, and closures above 4,096 entries, 1 GiB
total bytes, or 512 MiB per file. Use CODEX_UNRECOGNIZED_EXECUTION_FORM.

Staging copies the complete closure into a private 0700 directory, writes fixed permissions,
atomically renames the completed stage, reopens and rehashes every entry, and writes a private
manifest. A source-path replacement after staging cannot change staged bytes.

**Interfaces consumed:**

- Existing private-state file identity, atomic writer, no-follow, and ownership helpers.
- Generic artifact layout and diagnostic types from Task 1.

- [ ] **Step 1: Write failing tests.** Cover standalone package plus current symlink, official
  node wrapper plus native vendor payload, direct native file, changed member bytes, changed
  link target, traversal, unexpected launcher, ambiguous package, oversized closure, and
  configured-path replacement after staging.

    await expect(resolveCodexExecutionArtifact(join(root, "launcher.sh")))
      .rejects.toThrow("CODEX_UNRECOGNIZED_EXECUTION_FORM");
    const staged = await stageCodexExecutionArtifact({ artifact, stateRoot });
    await replaceFile(artifact.configuredPath, Buffer.from("different bytes"));
    await expect(verifyStagedCodexExecutionArtifact(staged)).resolves.toBeUndefined();

- [ ] **Step 2: Run RED.**

    pnpm exec vitest run apps/agent/src/codex-app-server/artifact-identity.test.ts

- [ ] **Step 3: Implement static layout recognition, bounded closure hashing, atomic staging,
  and staged readback verification.**

- [ ] **Step 4: Run GREEN and private-state tests.**

    pnpm exec vitest run apps/agent/src/codex-app-server/artifact-identity.test.ts apps/agent/src/private-state.test.ts

- [ ] **Step 5: Self-check and commit.**

    rg -n "execFile|spawn|exec\\(" apps/agent/src/codex-app-server/artifact-identity.ts
    git diff --check
    git add apps/agent/src/codex-app-server/artifact-identity.ts apps/agent/src/codex-app-server/artifact-identity.test.ts apps/agent/src/private-state.ts apps/agent/src/managed-workspaces.ts
    git commit -m "feat: identify Codex execution artifact closures"

## Task 4: Add the isolated compatibility-probe runtime

**Files:**

- Create: apps/agent/src/codex-app-server/probe-runtime.ts
- Create: apps/agent/src/codex-app-server/probe-runtime.test.ts
- Modify: apps/agent/src/docker-runtime.ts
- Modify: apps/agent/src/docker-runtime.test.ts
- Modify: apps/agent/src/managed-workspaces.ts

**Chosen mechanism:** Use the exact image ID of the running managed workspace development
container as the probe image. Extend DockerEngineClient.inspectContainer to retain image ID
and configured user, and inspectImage to retain OS and architecture. Use a separate short-lived
rootless Docker container, not an exec in the workspace container. This proves the probe and
eventual provider share the same image/ABI target without re-resolving a mutable image tag.

The probe container has Image equal to the inspected managed image ID, NetworkMode none, no
binds/volumes/ports, no workspace or host filesystem, no Project Options environment, no Codex
credential, only empty temporary HOME/CODEX_HOME, the managed container user, privileged false,
no devices, no Docker/Agent socket, no restart policy, and administrator-bounded CPU/memory/PID
limits.

The closure is copied into the probe container through an attached Docker exec stream. Fixed
commands run the generated entrypoint:

    /opt/devspace-codex-probe/bin/codex --version
    /opt/devspace-codex-probe/bin/codex app-server generate-json-schema --out /opt/devspace-codex-probe/output/stable
    /opt/devspace-codex-probe/bin/codex app-server generate-json-schema --experimental --out /opt/devspace-codex-probe/output/experimental

Each command has a 30-second deadline, the probe has a 90-second deadline, stdout/stderr is
capped at 1 MiB per command, generated files are capped at 8 MiB each and 32 MiB total, and
output file count is capped at 32. Stop/remove the exact probe container in finally; cleanup
failure returns provider-unavailable without exposing container details.

**Interfaces produced:**

    export interface CodexProbeRuntimeIdentity {
      readonly imageId: string;
      readonly operatingSystem: string;
      readonly architecture: string;
      readonly containerUser: string;
      readonly policyVersion: "codex-probe-runtime-v1";
    }

    export interface CodexProbeResult {
      readonly runtime: CodexProbeRuntimeIdentity;
      readonly versionOutput: string;
      readonly schemaFiles: ReadonlyMap<string, Uint8Array>;
    }

    export interface CodexProbeRuntime {
      probe(input: {
        readonly managedContainerId: string;
        readonly stagedArtifact: StagedCodexExecutionArtifact;
        readonly workspaceContext: WorkspaceExecutionContext;
      }): Promise<CodexProbeResult>;
    }

    export function createCodexProbeRuntime(input: {
      readonly docker: DockerEngineClient;
      readonly createId: () => string;
    }): CodexProbeRuntime;

The probe-specific container method must not reuse createContainer's worktree bind or workspace
network defaults. Its serialized HostConfig is tested for no mounts, network none, no privileges,
no devices, no credentials, and no automatic restart.

**Interfaces consumed:**

- WorkspaceExecutionContext and RuntimeOwnership.
- StagedCodexExecutionArtifact from Task 3.
- Existing rootless Docker socket verification and bounded exec stream handling.

- [ ] **Step 1: Write failing Docker/probe tests.** Assert exact image ID, no network, no
  mounts, no workspace path, no configured secrets, bounded output/time, and cleanup.

    expect(createRequests[0]).toMatchObject({
      Image: "sha256:managed-image",
      HostConfig: { NetworkMode: "none", Binds: [], Mounts: [], Privileged: false, Devices: [] }
    });
    expect(JSON.stringify(createRequests)).not.toContain("GITHUB");
    expect(JSON.stringify(createRequests)).not.toContain("workspace-secret");

- [ ] **Step 2: Run RED.**

    pnpm exec vitest run apps/agent/src/codex-app-server/probe-runtime.test.ts apps/agent/src/docker-runtime.test.ts

- [ ] **Step 3: Implement Docker image identity and isolated-container primitives, then the
  probe lifecycle with fixed commands, bounded collection, exact artifact upload, and cleanup.**

- [ ] **Step 4: Run GREEN.**

    pnpm exec vitest run apps/agent/src/codex-app-server/probe-runtime.test.ts apps/agent/src/docker-runtime.test.ts

- [ ] **Step 5: Self-check and commit.**

    rg -n "NetworkMode|Mounts|Binds|GITHUB|workspace|Docker" apps/agent/src/codex-app-server/probe-runtime.ts
    git diff --check
    git add apps/agent/src/codex-app-server/probe-runtime.ts apps/agent/src/codex-app-server/probe-runtime.test.ts apps/agent/src/docker-runtime.ts apps/agent/src/docker-runtime.test.ts apps/agent/src/managed-workspaces.ts
    git commit -m "feat: isolate Codex compatibility probing"

## Task 5: Add private discovery caching and the discovery orchestrator

**Files:**

- Create: apps/agent/src/codex-app-server/discovery-cache.ts
- Create: apps/agent/src/codex-app-server/discovery-cache.test.ts
- Create: apps/agent/src/codex-app-server/discovery.ts
- Create: apps/agent/src/codex-app-server/discovery.test.ts
- Modify: apps/agent/src/private-state.ts
- Modify: apps/agent/src/managed-workspaces.ts

**Interfaces produced:**

    export interface CodexProfileAuthorityInput {
      readonly providerKind: "codex";
      readonly reportedVersion: string;
      readonly entrypointSha256: string;
      readonly executionArtifactClosureDigest: string;
      readonly executionArtifactLayout: CodexArtifactLayout;
      readonly protocolFamily: "stdio-jsonl";
      readonly stableSchemaFingerprint: string;
      readonly experimentalSchemaFingerprint: string | null;
      readonly effectiveCapabilities: CodexCapabilitySet;
      readonly experimentalApi: boolean;
      readonly approvalPolicy: "on-request";
      readonly approvalsReviewer: "user";
      readonly semanticAdapterVersion: string;
      readonly compatibilityPolicyVersion: string;
      readonly probeRuntimeIdentity: CodexProbeRuntimeIdentity;
      readonly credentialSourceIdentity: string;
      readonly runtimeIdentity: {
        readonly projectId: string;
        readonly workspaceId: string;
        readonly revisionId: string;
        readonly runtimePlanHash: string;
        readonly runtimeGeneration: number;
      };
    }

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

    export interface CodexDiscoveryResult {
      readonly artifact: CodexExecutionArtifact;
      readonly stagedArtifact: StagedCodexExecutionArtifact;
      readonly probe: CodexProbeResult;
      readonly compatibility: CodexCompatibilityEvaluation;
      readonly profileAuthority: CodexProfileAuthorityInput;
    }

    export function discoverCodex(input: {
      readonly configuredPath: string;
      readonly managedContainerId: string;
      readonly workspaceContext: WorkspaceExecutionContext;
      readonly stateRoot: string;
      readonly docker: DockerEngineClient;
      readonly createId: () => string;
    }): Promise<CodexDiscoveryResult>;

**Interfaces consumed:**

- CodexExecutionArtifact and StagedCodexExecutionArtifact from Task 3.
- CodexProbeRuntime, CodexProbeResult, and CodexProbeRuntimeIdentity from Task 4.
- Existing private-state atomic file and single-flight conventions.

The cache is Agent-private at ai/codex-discovery-cache/<closure-digest>.json. It stores only
bounded fingerprints, feature results, capabilities, and stable failure codes. It never stores
raw schemas, provider messages, credentials, native IDs, or browser data.

Each discovery call resolves, rereads, stages, and rehashes the configured closure before cache
lookup. A hit skips schema regeneration only. The key binds closure digest, image/ABI identity,
schema command contract, cache format, semantic adapter version, and compatibility policy.
Corrupt or oversized cache files are ignored and replaced after fresh probing. Concurrent calls
are single-flighted by closure key.

Minimum-version parsing accepts the supported Codex output form, rejects malformed output, and
rejects only values below 0.145.0. It never rejects a newer version merely because it is untested.

- [ ] **Step 1: Write failing tests.** Cover cache hit, source rehash on hit, closure mutation,
  runtime/policy invalidation, malformed/oversized cache, atomic write failure, single-flight,
  minimum-version rejection, newer-version acceptance, and bounded diagnostics.

    const first = await discoverCodex(input);
    const second = await discoverCodex(input);
    expect(probe.schemaCalls).toBe(1);
    expect(second.compatibility.stableSchemaFingerprint)
      .toBe(first.compatibility.stableSchemaFingerprint);

- [ ] **Step 2: Run RED.**

    pnpm exec vitest run apps/agent/src/codex-app-server/discovery-cache.test.ts apps/agent/src/codex-app-server/discovery.test.ts

- [ ] **Step 3: Implement bounded cache storage, single-flight discovery, version parsing,
  artifact staging, probe/cache selection, evaluator invocation, and private result assembly.**

- [ ] **Step 4: Run GREEN.**

    pnpm exec vitest run apps/agent/src/codex-app-server/discovery-cache.test.ts apps/agent/src/codex-app-server/discovery.test.ts

- [ ] **Step 5: Self-check and commit.**

    rg -n "schemaFiles|rawParams|nativeRequestId|credential|token|password" apps/agent/src/codex-app-server/discovery-cache.ts
    git diff --check
    git add apps/agent/src/codex-app-server/discovery-cache.ts apps/agent/src/codex-app-server/discovery-cache.test.ts apps/agent/src/codex-app-server/discovery.ts apps/agent/src/codex-app-server/discovery.test.ts apps/agent/src/private-state.ts apps/agent/src/managed-workspaces.ts
    git commit -m "feat: cache Codex compatibility discovery by artifact"

## Task 6: Move profile authority and dynamic capability projection into discovery

**Files:**

- Create: apps/agent/src/codex-app-server/profile-authority.ts
- Create: apps/agent/src/codex-app-server/profile-authority.test.ts
- Modify: apps/agent/src/ai-session-runtime.ts
- Modify: apps/agent/src/ai-session-runtime.test.ts
- Modify: apps/agent/src/server.ts
- Modify: packages/contracts/src/ai-sessions.ts
- Modify: packages/contracts/src/provider-adapters/ai-profile-revision-v1.ts
- Modify: packages/contracts/src/provider-adapters/ai-profile-revision-v1.test.ts

**Interfaces consumed:**

- CodexProfileAuthorityInput, CodexDiscoveryResult, and CodexCapabilitySet from Task 5.
- Existing AiProviderProfileProjection and profile-revision hashing contracts.

**Interfaces produced:**

    // Uses CodexProfileAuthorityInput from Task 5 as its canonical input.
    export function codexProfileRevisionForDiscovery(input: CodexProfileAuthorityInput): string;
    export function safeCodexProfileProjection(input: {
      readonly revision: string;
      readonly capabilities: CodexCapabilitySet;
      readonly availability: AiProviderProfileProjection["availability"];
    }): AiProviderProfileProjection;

Replace hard-coded executable hash, exact version output, fixed capability object, and default
profile revision authority in ai-session-runtime.ts with the discovery result. The profile hash
includes actual version, entrypoint/closure digest and layout, schema fingerprints, effective
capabilities, probe image/ABI identity, experimental opt-in, approval policy/reviewer,
semantic/policy versions, credential source identity, and existing runtime/workspace identity.
Display names and other cosmetic metadata are excluded.

Discovery rejects approval capability false or incompatible before returning an available
writable profile. structuredInput false and interrupt false are safe projections only when their
absence cannot leave an unhandled blocking request. Map private discovery failures to bounded
enumerated availability codes; never include paths, schemas, raw stderr, or native diagnostics.

- [ ] **Step 1: Write failing profile tests.** Prove byte/closure, protocol fingerprint,
  optional capability, probe image, approval policy/reviewer, and experimental opt-in changes
  alter revision. Prove display name does not. Prove 0.153.4 compatible evidence is available
  and 0.144.0 is unavailable.

- [ ] **Step 2: Run RED.**

    pnpm exec vitest run apps/agent/src/codex-app-server/profile-authority.test.ts apps/agent/src/ai-session-runtime.test.ts -t "profile|inspect"

- [ ] **Step 3: Implement profile authority, dynamic safe projection, and runtime inspection
  through discovery.** Fake mode uses deterministic generic compatibility types and does not
  advertise a production 0.145 identity.

- [ ] **Step 4: Run GREEN.**

    pnpm exec vitest run apps/agent/src/codex-app-server/profile-authority.test.ts apps/agent/src/ai-session-runtime.test.ts -t "profile|inspect"
    pnpm exec vitest run packages/contracts/src/provider-adapters/ai-profile-revision-v1.test.ts packages/contracts/src/ai-sessions.test.ts

- [ ] **Step 5: Self-check and commit.**

    rg -n "CODEX_EXECUTABLE_SHA256|VERSION_MISMATCH|CODEX_APP_SERVER_CLI_VERSION|CODEX_CAPABILITIES" apps/agent/src/ai-session-runtime.ts apps/agent/src/server.ts
    git diff --check
    git add apps/agent/src/codex-app-server/profile-authority.ts apps/agent/src/codex-app-server/profile-authority.test.ts apps/agent/src/ai-session-runtime.ts apps/agent/src/ai-session-runtime.test.ts apps/agent/src/server.ts packages/contracts
    git commit -m "feat: derive Codex profile authority from discovery"

## Task 7: Bind managed provider launch to the exact probed artifact

**Files:**

- Create: apps/agent/src/codex-app-server/artifact-stager.ts
- Create: apps/agent/src/codex-app-server/artifact-stager.test.ts
- Create: apps/agent/native/codex-artifact-readback.c
- Modify: tooling/build-staged-readback-helper.mjs
- Modify: apps/agent/src/ai-session-runtime.ts
- Modify: apps/agent/src/ai-session-runtime.test.ts
- Modify: apps/agent/src/codex-credential-authority.ts
- Modify: apps/agent/src/codex-credential-authority.test.ts

**Interfaces produced:**

    export interface CodexLaunchArtifact {
      readonly staged: StagedCodexExecutionArtifact;
      readonly managedImageId: string;
      readonly probeRuntime: CodexProbeRuntimeIdentity;
      readonly profileRevision: string;
    }

    export interface CodexArtifactStager {
      stageIntoManagedProvider(input: {
        readonly containerId: string;
        readonly launchArtifact: CodexLaunchArtifact;
        readonly sessionId: string;
        readonly processGeneration: number;
      }): Promise<{
        readonly containerRoot: string;
        readonly entrypointPath: string;
        readonly artifactReadbackPath: string;
      }>;
    }

**Interfaces consumed:**

- StagedCodexExecutionArtifact from Task 3 and CodexProbeRuntimeIdentity from Task 4.
- CodexProfileAuthorityInput and profile revision from Tasks 5 and 6.
- Existing DockerEngineClient and credential-authority launch contracts.

The stager uploads every closure entry under a private generated directory, preserving relative
paths and executable modes. It uploads a private manifest, invokes an Agent-owned artifact
readback helper, streams the bounded binary readback through an Agent hash, and compares every
file/link/mode and the closure digest before app-server launch. The helper opens regular files
with O_NOFOLLOW, rejects devices/traversal, reports bounded metadata and bytes using a
versioned private frame, and never logs or returns credentials.

Provider start must verify the managed image ID/OS/architecture equals discovery authority,
use only the staged closure, upload existing credential material separately, launch fixed
app-server stdio arguments, and refuse any digest/image/mode/path/profile mismatch. It never
rereads the configured executable path.

- [ ] **Step 1: Write failing launch-binding tests.** Assert all closure members upload,
  path replacement after discovery has no effect, image drift fails before launch, readback
  mismatch fails before launch, and no provider process starts before proof.

- [ ] **Step 2: Run RED.**

    pnpm exec vitest run apps/agent/src/codex-app-server/artifact-stager.test.ts apps/agent/src/ai-session-runtime.test.ts -t "artifact|staging|launch"

- [ ] **Step 3: Implement the separate artifact readback helper and TypeScript parser, then
  extract upload/readback staging from CodexProvider.** Keep credential readback separate.

- [ ] **Step 4: Run GREEN and helper build.**

    pnpm --filter @devspace/agent run build:helper
    pnpm exec vitest run apps/agent/src/codex-app-server/artifact-stager.test.ts apps/agent/src/ai-session-runtime.test.ts -t "artifact|staging|launch"

- [ ] **Step 5: Self-check and commit.**

    rg -n "readFile\\(.*executable|execFile.*codex|options\\.executablePath" apps/agent/src
    git diff --check
    git add apps/agent/src/codex-app-server/artifact-stager.ts apps/agent/src/codex-app-server/artifact-stager.test.ts apps/agent/native/codex-artifact-readback.c tooling/build-staged-readback-helper.mjs apps/agent/src/ai-session-runtime.ts apps/agent/src/ai-session-runtime.test.ts apps/agent/src/codex-credential-authority.ts apps/agent/src/codex-credential-authority.test.ts
    git commit -m "feat: launch only the probed Codex artifact"

## Task 8: Migrate the pinned semantic adapter into the generic Codex protocol family

**Files:**

- Create: apps/agent/src/codex-app-server/transport.ts
- Create: apps/agent/src/codex-app-server/transport.test.ts
- Rename: apps/agent/src/codex-interactions-v0-145.ts to apps/agent/src/codex-app-server/interactions.ts
- Rename: apps/agent/src/codex-interactions-v0-145.test.ts to apps/agent/src/codex-app-server/interactions.test.ts
- Rename: apps/agent/src/codex-notification-schema-v0-145.ts to apps/agent/src/codex-app-server/notifications.ts
- Create: apps/agent/src/codex-app-server/notifications.test.ts
- Create: apps/agent/src/codex-app-server/provider.ts
- Modify: apps/agent/src/ai-session-runtime.ts
- Modify: apps/agent/src/ai-session-runtime.test.ts
- Modify: apps/agent/src/server.ts

**Interfaces consumed:**

- Generic Codex compatibility, artifact launch, and profile-authority interfaces from Tasks 1
  through 7.
- Existing canonical AI event callbacks, durable interaction projection, outbox receipts, and
  provider-generation lifecycle in ai-session-runtime.ts.

**Interfaces produced:**

    export interface CodexInteractionPolicy {
      readonly approvals: true;
      readonly structuredInput: boolean;
      readonly maxPresentationPaths: number;
      readonly maxQuestions: number;
      readonly maxOptions: number;
    }

    export interface CodexProviderCallbacks {
      readonly outputDelta: (text: string) => Promise<void>;
      readonly activity: (summary: string) => Promise<void>;
      readonly interactionRequested: (projection: CodexInteractionProjection) => Promise<void>;
      readonly interactionResolved: (requestId: string, cause: "provider-resolved" | "provider-expired") => Promise<void>;
      readonly completed: (outcome: "completed" | "interrupted" | "failed") => Promise<void>;
      readonly providerIncompatible: (diagnostic: CodexCompatibilityDiagnostic) => Promise<void>;
      readonly privateFailure: (observation: CodexPrivateFailureObservation) => void;
      readonly failed: (observation: CodexPrivateFailureObservation) => Promise<void>;
      readonly providerClosed: () => Promise<void>;
    }

    export function parseCodexServerInteractionRequest(value: unknown, policy: CodexInteractionPolicy): CodexServerInteractionRequest | null;
    export function projectCodexApprovalRequest(
      request: CodexServerInteractionRequest,
      turnId: string,
      createId: () => string,
      fileChangeItems: ReadonlyMap<string, CodexFileChangeItem>
    ): ApprovalProjection | null;
    export function projectCodexInputRequest(
      request: CodexServerInteractionRequest,
      turnId: string,
      createId: () => string
    ): InputProjection | null;
    export function encodeCodexApprovalResponse(
      request: CodexServerInteractionRequest,
      decision: AiApprovalDecision
    ): Readonly<{ decision: "accept" | "acceptForSession" | "decline" | "cancel" }>;
    export function encodeCodexInputResponse(
      mapping: CodexInputMapping,
      answers: readonly AiStructuredInputAnswer[]
    ): Readonly<{ answers: Record<string, { answers: string[] }> }>;

The renamed interaction module keeps all provider-native IDs and exact native option labels in
Agent-private mappings. It continues to redact command, reason, summary, header, question,
option label, and option description before public projection. It keeps file-change paths
correlated by native threadId, turnId, and itemId; grantRoot is never converted into a path.
It preserves native truncation facts, handles added/modified/deleted/rename metadata, and
rejects unsafe or unproven path lists.

The 0.145 behavior remains the semantic baseline, but no production function or type may be
named v0-145. Structured input requires non-empty options and isOther true; public option IDs
map to private exact native labels, and Other answers encode user_note: followed by bounded
user text. autoResolutionMs is validated as integer-or-null and never projected.

Notification policy:

- project and handle known assistant/activity/terminal notifications;
- handle serverRequest/resolved privately and idempotently;
- validate and ignore only known or explicitly safe non-blocking notifications;
- reject unknown enum values in requests, terminal states, approvals, or input;
- treat an unknown message with an id as an unknown blocking request.

The exact unknown-request function is CodexProvider.handleUnknownBlockingRequest. It retains
only CODEX_UNKNOWN_BLOCKING_REQUEST, retires/fences pending interactions, rejects local JSON-RPC
promises, invokes providerIncompatible without raw params, destroys the attached stream, proves
provider exec termination, and lets ai-session-runtime emit turn.lost/session.lost through the
existing lifecycle. Current-generation checks ignore late messages. Default behavior sends no
JSON-RPC response; a generic -32601 with native id and no data is allowed only when the writer
is proven safe and is never a semantic response.

- [ ] **Step 1: Write failing transport, interaction, and notification tests.** Move the
  current 0.145 tests to generic paths and add additive notifications, unknown non-blocking
  notifications, unknown blocking requests, duplicate/late teardown messages, resolved-before
  and resolved-after-response, exact option mapping, and redaction cases.

- [ ] **Step 2: Run RED.**

    pnpm exec vitest run apps/agent/src/codex-app-server/transport.test.ts apps/agent/src/codex-app-server/interactions.test.ts apps/agent/src/codex-app-server/notifications.test.ts apps/agent/src/ai-session-runtime.test.ts -t "notification|interaction|protocol"

- [ ] **Step 3: Extract bounded Docker-multiplexed JSONL transport and move interaction/
  notification semantics into generic modules.** Inject optional-capability policy while
  preserving safe public/private mappings.

- [ ] **Step 4: Extract CodexProvider from ai-session-runtime.ts.** The provider module owns
  native identities, JSON-RPC tracking, file-change item state, native writes, process teardown,
  and provider callbacks. The session runtime owns DevSpace binding, canonical events, turns,
  and terminal claims.

- [ ] **Step 5: Implement terminal unknown-request teardown and protocol-incompatibility
  finalization.** Retire interactions, emit only bounded diagnostics, release the lease only
  after cleanup proof, and fence browser responses.

- [ ] **Step 6: Run GREEN.**

    pnpm exec vitest run apps/agent/src/codex-app-server/transport.test.ts apps/agent/src/codex-app-server/interactions.test.ts apps/agent/src/codex-app-server/notifications.test.ts apps/agent/src/ai-session-runtime.test.ts

- [ ] **Step 7: Self-check and commit.**

    rg -n "v0-145|nativeRequestId|providerThreadId|rawParams" apps/agent/src/codex-app-server apps/agent/src/ai-session-runtime.ts
    git diff --check
    git add apps/agent/src/codex-app-server apps/agent/src/ai-session-runtime.ts apps/agent/src/ai-session-runtime.test.ts apps/agent/src/server.ts
    git commit -m "refactor: migrate Codex semantics to the protocol family"

## Task 9: Integrate dynamic capabilities, profile fencing, and profile-aware sessions

**Files:**

- Modify: apps/agent/src/ai-session-runtime.ts
- Modify: apps/agent/src/ai-session-runtime.test.ts
- Modify: apps/agent/src/server.ts
- Modify: apps/web/src/server/ai-sessions.ts
- Modify: apps/web/src/server/ai-sessions.test.ts
- Modify: apps/web/src/server/database.ts
- Modify: apps/web/src/server/database.test.ts
- Modify: packages/contracts/src/ai-sessions.ts
- Modify: packages/contracts/src/ai-sessions.test.ts
- Modify: packages/domain/src/ai-session-lifecycles.test.ts

**Interfaces consumed:**

- Dynamic AiProviderProfileProjection and CodexCapabilitySet from Task 6.
- CodexProvider launch/profile binding from Tasks 7 and 8.
- Existing Web route authority, database transaction, lease, and lifecycle contracts.

**Interfaces produced:**

    type InitialAiSessionResult =
      | { readonly kind: "created"; readonly session: AiSession }
      | { readonly kind: "reused-current-profile"; readonly session: AiSession }
      | { readonly kind: "blocked-by-live-profile"; readonly session: AiSession };

    createInitialAiSession(input: {
      projectId: string;
      workspaceId: string;
      profileId: string;
      profileRevision: string;
      title?: string;
    }): InitialAiSessionResult;

    function reconcileProfilePinnedSession(
      record: SessionRecord,
      currentProfile: AiProviderProfileProjection
    ): Promise<void>;

Change createInitialAiSession so its transaction verifies project/workspace ownership, reuses a
current-profile creating/active/waiting/interrupted session, rejects a different live profile
without creating another provider session, ignores stopped/lost/unavailable history for lease
blocking, creates one current-profile session when no live session exists, and preserves the
existing immediate transaction and initial retry claim.

Web createAiSession must branch on this result. Restart remains exact-profile only; an old-profile
stopped/lost session is selectable for history but restart returns AI_PROFILE_REVISION_CONFLICT.
At Agent start and cold reconstruction, compare persisted binding revision with discovery.
An active old generation is never replaced in place. After Agent restart, old-profile sessions
become lost/history-only rather than resuming under new bytes. Late events fail currentGeneration.

Approvals must be true for an available writable profile. structuredInput false removes only
structured-input actions, interrupt false removes only interrupt, initialize sends
experimentalApi true only when admitted, and thread/start always sends approvalPolicy on-request
and approvalsReviewer user from Agent authority.

- [ ] **Step 1: Write failing database/runtime tests.** Cover current-profile reuse,
  different-live-profile rejection, historical old-profile creation, ambiguous Create
  idempotency, exact restart fencing, Agent restart mismatch, capability projection, and
  thread/start authority.

- [ ] **Step 2: Run RED.**

    pnpm exec vitest run apps/web/src/server/database.test.ts apps/web/src/server/ai-sessions.test.ts apps/agent/src/ai-session-runtime.test.ts -t "profile|session|restart|capability|lease"

- [ ] **Step 3: Implement database result and Web branching, retaining existing transactions
  and exact route checks. Do not add a SQLite capability cache.**

- [ ] **Step 4: Implement Agent profile fencing and capability-aware provider launch.**

- [ ] **Step 5: Run GREEN.**

    pnpm exec vitest run apps/web/src/server/database.test.ts apps/web/src/server/ai-sessions.test.ts apps/agent/src/ai-session-runtime.test.ts -t "profile|session|restart|capability|lease"

- [ ] **Step 6: Self-check and commit.**

    rg -n "approvalPolicy.*never|createInitialAiSession|prepareAiSessionRestart|profileRevision" apps/agent/src apps/web/src/server packages/database/src
    git diff --check
    git add apps/agent/src/ai-session-runtime.ts apps/agent/src/ai-session-runtime.test.ts apps/agent/src/server.ts apps/web/src/server/ai-sessions.ts apps/web/src/server/ai-sessions.test.ts apps/web/src/server/database.ts apps/web/src/server/database.test.ts packages/contracts/src/ai-sessions.ts packages/contracts/src/ai-sessions.test.ts packages/domain/src/ai-session-lifecycles.test.ts
    git commit -m "feat: fence AI sessions to discovered Codex profiles"

## Task 10: Add the compatibility fixture matrix

**Files:**

- Create: packages/contracts/fixtures/codex-app-server/0.153.4/protocol-manifest.json
- Create: packages/contracts/fixtures/codex-app-server/0.153.4/stable/ClientRequest.json
- Create: packages/contracts/fixtures/codex-app-server/0.153.4/stable/ClientNotification.json
- Create: packages/contracts/fixtures/codex-app-server/0.153.4/stable/ServerRequest.json
- Create: packages/contracts/fixtures/codex-app-server/0.153.4/stable/ServerNotification.json
- Create: packages/contracts/fixtures/codex-app-server/0.153.4/experimental/ToolRequestUserInputParams.json
- Create: packages/contracts/fixtures/codex-app-server/0.153.4/UPSTREAM-NOTICE.md
- Create: apps/agent/src/codex-app-server/compatibility-matrix.test.ts
- Modify: packages/contracts/src/provider-adapters/codex-app-server-baseline-fixture.test.ts
- Modify: apps/agent/src/codex-app-server/schema-compatibility.test.ts
- Modify: packages/contracts/src/index.ts

**Interfaces produced:**

- Checked-in 0.153.4 schema manifests and deterministic compatibility-matrix fixtures;
  no new runtime authority interface.

**Interfaces consumed:**

- CodexSchemaBundle, CodexCompatibilityEvaluation, and feature predicates from Task 2.
- The isolated CodexProbeRuntime and baseline fixture format from Tasks 1 and 4.

Capture the newer fixture from the actual installed 0.153.4 executable through the isolated
CodexProbeRuntime. Do not run it directly on the Agent host and do not commit the executable
or its hash as an authorization rule. Capture only bounded schema JSON, manifest sizes,
fingerprints, version/source metadata, and the upstream Apache-2.0 notice. If the exact
installed executable is unavailable, stop this task and report the missing real fixture rather
than labeling synthetic data as 0.153.4.

Add deterministic synthetic cases for additive object properties, additive enum members,
missing required basic-session methods, malformed/unresolved/cyclic shapes, missing structured
input, missing approval correlation, unknown blocking envelopes, and compatible newer versions.
Both 0.145 and 0.153.4 must admit basic sessions and required approvals when their schemas do.
Missing structured input retains basic turns and approvals. Missing approval makes the writable
profile unavailable.

- [ ] **Step 1: Write failing matrix tests.**

    test("accepts the pinned baseline and captured newer fixture", async () => {
      for (const fixture of ["0.145.0", "0.153.4"]) {
        const result = await evaluateFixture(fixture);
        expect(result.features.basicSession.state).toBe("supported");
        expect(result.features.approvals.state).toBe("supported");
      }
    });

- [ ] **Step 2: Run RED.**

    pnpm exec vitest run apps/agent/src/codex-app-server/compatibility-matrix.test.ts apps/agent/src/codex-app-server/schema-compatibility.test.ts

- [ ] **Step 3: Capture/load the real fixture through the probe path and add synthetic mutation
  helpers. Keep runtime probing out of CI.**

- [ ] **Step 4: Run GREEN.**

    pnpm exec vitest run apps/agent/src/codex-app-server/compatibility-matrix.test.ts apps/agent/src/codex-app-server/schema-compatibility.test.ts packages/contracts/src/provider-adapters/codex-app-server-baseline-fixture.test.ts

- [ ] **Step 5: Self-check and commit.**

    rg -n "0\\.153\\.4|0\\.145\\.0|cliBinarySha256|hash" packages/contracts/fixtures apps/agent/src/codex-app-server
    git diff --check
    git add packages/contracts/fixtures/codex-app-server/0.153.4 apps/agent/src/codex-app-server/compatibility-matrix.test.ts apps/agent/src/codex-app-server/schema-compatibility.test.ts packages/contracts/src
    git commit -m "test: add Codex compatibility fixture matrix"

## Task 11: Preserve deterministic browser acceptance through the generic capability path

**Files:**

- Create: apps/agent/src/codex-app-server/fake-provider.ts
- Create: apps/agent/src/codex-app-server/fake-provider.test.ts
- Modify: apps/agent/src/ai-session-runtime.ts
- Modify: apps/agent/src/ai-session-runtime.test.ts
- Modify: apps/agent/src/ai-session-server.test.ts
- Modify: e2e/z-ai-session.spec.ts
- Modify: apps/web/src/server/ai-sessions.test.ts

**Interfaces produced:**

- A deterministic fake Codex provider seam implementing the generic CodexProvider test
  callbacks; no production provider authority is added.

**Interfaces consumed:**

- Generic interaction/notification contracts from Task 8 and capability projections from Task 9.
- Existing AI-session API, Workbench routing, and Playwright fixture interfaces.

Extract the deterministic fake provider from ai-session-runtime.ts. Its structured-input fixture
matches pinned 0.145 semantics: every question has non-empty options, isOther is true, listed
responses map through private native labels, and Other responses produce user_note: followed
by bounded text. The fake is a test seam, not evidence production is pinned to 0.145.

The Playwright flow continues to cover session create/select, approve once, deny, a listed
structured answer, an Other answer, resolved non-actionable state, changed-file Workbench
opening, refresh, persisted-session switching, late-event isolation, interruption, and a later
turn. Add a fake capability case where structuredInput is false and no impossible action renders.

- [ ] **Step 1: Write failing fake/browser assertions.** Prove listed and Other private
  encodings differ, resolved cards have no active controls, and old-session late events are
  ignored.

- [ ] **Step 2: Run RED.**

    pnpm exec vitest run apps/agent/src/codex-app-server/fake-provider.test.ts apps/agent/src/ai-session-runtime.test.ts apps/web/src/server/ai-sessions.test.ts
    pnpm exec playwright test e2e/z-ai-session.spec.ts --list

- [ ] **Step 3: Extract/update the fake provider and browser assertions without changing
  existing Workbench or session UX architecture.**

- [ ] **Step 4: Run GREEN.**

    pnpm exec vitest run apps/agent/src/codex-app-server/fake-provider.test.ts apps/agent/src/ai-session-runtime.test.ts apps/web/src/server/ai-sessions.test.ts
    pnpm exec playwright test e2e/z-ai-session.spec.ts

- [ ] **Step 5: Self-check and commit.**

    rg -n "nativeRequestId|nativeOptionLabel|structuredInput|late" apps/agent/src/codex-app-server/fake-provider.ts e2e/z-ai-session.spec.ts
    git diff --check
    git add apps/agent/src/codex-app-server/fake-provider.ts apps/agent/src/codex-app-server/fake-provider.test.ts apps/agent/src/ai-session-runtime.ts apps/agent/src/ai-session-runtime.test.ts apps/agent/src/ai-session-server.test.ts e2e/z-ai-session.spec.ts apps/web/src/server/ai-sessions.test.ts
    git commit -m "test: keep AI browser fixtures protocol-family compatible"

## Task 12: Update current-state documentation without rewriting Checkpoint 2 history

**Files:**

- Modify: docs/current-state.md
- Modify: docs/roadmap.md
- Modify: docs/specs/ai-sessions-v1.md
- Modify: docs/references/product-references.md
- Modify: docs/attributions/t3code-ai-session.md

**Interfaces produced:**

- Updated current-state, roadmap, AI-session specification, and neutral product-reference
  documentation; no runtime interface.

**Interfaces consumed:**

- The approved compatibility design and existing documentation authority order.

Update only current-state and roadmap wording that describes Codex 0.145 as the exclusive
production executable. State that 0.145.0 is the minimum compatibility baseline, newer
compatible releases are admitted by protocol/capability discovery, and cross-version live
session resumption is not promised. Record isolated probing, artifact closure authority,
required writable-profile approvals, and safe optional capability degradation.

Keep historical Checkpoint 2 design and implementation plan text as history. Add only a short
link to the version-compatibility design where a future executor needs the new authority.

Keep references neutral: Orca is primary for Workbench and AI-session UX; T3 Code is secondary
for isolated technical mechanics; DevSpace authority overrides both; no T3 source was copied
or substantially adapted.

- [ ] **Step 1: Write documentation assertions** using the repository text-test convention:
  current-state must contain minimum/no-upper-bound, isolated-probe, required-approval, and
  Orca-first/T3-second language, and must not say the exact 0.145 executable is the only
  authorized production binary.

- [ ] **Step 2: Run RED.**

    rg -n "only authorized|exclusive.*0\\.145|Codex 0\\.145.*only|Orca first|T3 second" docs/current-state.md docs/roadmap.md docs/specs/ai-sessions-v1.md docs/references/product-references.md docs/attributions/t3code-ai-session.md

- [ ] **Step 3: Update the bounded text while preserving merge history and completed
  Checkpoint 2 claims.**

- [ ] **Step 4: Run GREEN and commit.**

    rg -n "0\\.145\\.0|no upper|isolated|approval|Orca|T3" docs/current-state.md docs/roadmap.md docs/specs/ai-sessions-v1.md docs/references/product-references.md docs/attributions/t3code-ai-session.md
    git diff --check
    git add docs/current-state.md docs/roadmap.md docs/specs/ai-sessions-v1.md docs/references/product-references.md docs/attributions/t3code-ai-session.md
    git commit -m "docs: record version-independent Codex support"

## Task 13: Run integrated verification, focused authority review, and real newer-Codex dogfood

**Files:**

- Modify only files found necessary by the focused review; do not perform unrelated cleanup.
- Test: all focused suites from Tasks 1 through 11 and e2e/z-ai-session.spec.ts.

**Interfaces produced:**

- Verification evidence and any narrowly scoped review correction; no planned new runtime
  interface.

**Interfaces consumed:**

- All contracts, evaluator, artifact, probe, provider, session, fixture, and browser outputs
  from Tasks 1 through 12.

Before full gates, perform one focused security/authority review of only the changed provider
boundary. Verify host never executes configured Codex code; recognized closure and exact
staged/probed/launched bytes are digest-bound; probe image ID is the managed provider image;
probe has no network, mounts, workspace, credentials, Agent socket, or Docker socket; profile
revision includes effective executable/protocol/capability/runtime authority; approvals remain
required; optional capability degradation is truthful; native IDs/labels/raw diffs/schemas stay
private; file paths come from exact item correlation; unknown blocking teardown retires,
terminates, diagnoses, and fences; old-profile sessions do not silently resume; and the
one-live-provider lease remains intact.

Fix substantive findings once, rerun only affected focused tests, then perform one final
integrated regression review. Do not dispatch a second whole-branch review.

Run the repository gates:

    pnpm install --frozen-lockfile
    pnpm workspace:check
    pnpm lint
    pnpm test
    pnpm typecheck
    pnpm build
    pnpm contracts:check
    pnpm schema:check
    pnpm db:migrate:test
    pnpm db:check
    git diff --check origin/main...HEAD

Run:

    pnpm exec playwright test e2e/z-ai-session.spec.ts

For real installed-Codex dogfood, use the normal configured entrypoint and new Agent discovery.
The investigated candidate is the official standalone 0.153.4 entrypoint resolved through
/config/.local/bin/codex. Do not execute it directly from the Agent shell, change the minimum,
add a hash allowlist, or substitute another binary. Inspect through the normal AI profile route,
confirm basicSession and required approvals, confirm structuredInput/interrupt reflect evidence,
then run browser acceptance for approvals, denial, structured input, changed files, refresh,
session switching, interruption, and a later turn. If a required predicate fails, record the
exact bounded diagnostic and predicate; do not weaken compatibility policy to pass dogfood.

- [ ] **Step 1: Run focused suites.**

    pnpm exec vitest run apps/agent/src/codex-app-server apps/agent/src/ai-session-runtime.test.ts apps/agent/src/ai-session-server.test.ts packages/contracts/src/provider-adapters packages/contracts/src/ai-sessions.test.ts apps/web/src/server/ai-sessions.test.ts

- [ ] **Step 2: Run all full gates and Playwright.** Record every exit status and preserve
  a real-provider-unavailable diagnostic as a blocker rather than claiming acceptance.

- [ ] **Step 3: Perform the one focused authority review, apply one correction pass if
  needed, and rerun only materially affected focused tests.**

- [ ] **Step 4: Perform the final integrated regression review.** Confirm send/reconnect,
  interrupt, stop, restart, history/output bounds, stream sequence, changed-file bounds,
  cleanup, interaction retirement, and Workbench behavior.

- [ ] **Step 5: Commit any review correction and push normally.**

    git diff --check origin/main...HEAD
    git status --short
    git push origin feat/ai-workbench-checkpoint-2

## Acceptance Criteria

1. Codex 0.145.0 passes as minimum baseline and a compatible newer Codex is accepted without
   a new release adapter, version allowlist, executable hash commit, or DevSpace release.
2. A version below 0.145.0 fails with CODEX_VERSION_BELOW_MINIMUM.
3. Additive schema/object/enum changes are tolerated; incompatible required semantics fail
   closed through bounded feature/provider diagnostics.
4. Configured provider code is never executed with Agent-host privileges.
5. Official standalone, official native-package, and recognized native executable closures are
   deterministic; arbitrary wrappers are rejected.
6. Exact closure and exact managed image identity used for probing are admitted for launch,
   with readback proof and TOCTOU tests.
7. Cache hits skip schema regeneration but still rehash source and invalidate on closure,
   runtime, evaluator, policy, or command-contract changes.
8. Command/file approvals remain required; incompatibility never silently becomes approvalPolicy
   never.
9. structuredInput and interrupt are disabled only when safely absent; no unsupported blocking
   request leaves Codex waiting.
10. Schema types never establish redaction, safe paths, approval intent, or trusted identity.
11. Unknown blocking requests terminate/fence the exact generation and expose only
    CODEX_UNKNOWN_BLOCKING_REQUEST.
12. Native IDs, native labels, raw diffs, schemas, and private diagnostics never enter public
    canonical events, SQLite, browser payloads, logs, or generic errors.
13. Profile revisions include effective authority; cosmetic display changes do not invalidate.
14. Old-profile sessions remain history-only after updates, do not silently resume, and do not
    block new sessions after they are stopped/lost; live leases remain truthful.
15. Deterministic fake/browser coverage uses pinned structured-input shape and exercises listed
    option, Other, resolved state, switching, changed files, refresh, interruption, and later
    turn.
16. Full gates and e2e/z-ai-session.spec.ts pass. Real newer-Codex dogfood is completed through
    normal authority or reported with its exact bounded compatibility blocker.
