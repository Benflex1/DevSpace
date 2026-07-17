# Project Options v1

## Principle and authority

Project Options is the UI surface for all project settings. Its General section edits project metadata owned by the `projects` entity: project display name, project slug, repository URL, default branch, and automatic fetch policy. Those values are not part of the immutable configuration JSON described by this specification. General edits do not create a runtime configuration revision and do not automatically rebuild existing workspaces.

This specification defines only the immutable runtime-configuration portion of Project Options. Runtime configuration is stored as immutable SQLite revisions; no `.devspace.yml` or other manually maintained repository configuration is required. The primary workspace display name belongs to its `workspaces` row, may default to `Primary` at project creation, and is not repeated in configuration revisions.

The Zod model that will live in `packages/project-options` is the executable source of truth. TypeScript types are inferred from it. `schemas/project-options-v1.schema.json` is a generated JSON Schema draft 2020-12 portability artifact and is not independently maintained. This task does not change that artifact.

A repository detector may populate a draft, but only an authenticated user can activate it. Active revisions are immutable. Existing workspaces stay pinned to their revision until explicitly rebuilt or migrated.

## Object and field rules

Every object is strict: an unknown key at any nesting level is invalid. A field described as required must be present in submitted input. An optional field may be omitted and is materialized to the stated default before canonicalization. `null` is accepted only where it is named as the default.

All documented sections below belong to Project Options v1. Runtime-plan compilation is a separate,
derived contract and does not alter the revision identity or configuration hash.

## Runtime-plan v1

`packages/project-options` owns the executable `devspace.runtime-plan/v1` schema and deterministic
compile, parse, canonicalize, and hash helpers. Canonical JSON uses the same RFC 8785/JCS machinery
as Project Options. Its SHA-256 input is domain-separated with `devspace/runtime-plan/v1`, so a
Project Options revision hash cannot be substituted for a runtime-plan hash.

The currently executable compiler accepts an image source, optional container user, `/workspace`,
literal environment values, declared TCP ports as metadata, and optional CPU/memory/PID requests.
It emits empty services, named volumes, and setup steps and requires `passwordlessSudo: false`.
Preset and Dockerfile sources, supporting services, named volumes or mounts, setup steps,
non-literal environment bindings, and passwordless sudo remain valid Project Options but produce a
typed unsupported-compilation error rather than a partial plan.

Web stores the canonical plan and hash as a validated pair in `project_config_revisions`. Existing
revisions with a null pair are compiled lazily on first start without changing configuration JSON,
configuration hash, revision number, or revision ID. The Agent retains the canonical Project
Options revision, recompiles independently during runtime-plan registration, and rejects any
canonical bytes, plan hash, revision ID, or revision hash mismatch.

### Root object

| Field | Requirement | Meaning and default |
| --- | --- | --- |
| `schemaVersion` | required | Integer constant `1`. |
| `namedVolumes` | optional | Unordered keyed collection of workspace-scoped volume declarations; default `[]`. |
| `developmentEnvironment` | required | Workspace image source and container defaults. |
| `tasks` | optional | Unordered keyed collection; default `[]`. |
| `services` | optional | Unordered keyed collection; default `[]`. |
| `previews` | optional | Unordered keyed collection; default `[]`. |
| `aiProfile` | optional | One approved AI CLI profile or `null`; default `null`. |
| `resources` | optional | Resource and cleanup policy; default is the fully materialized object below. |

### Named volumes

Each optional `namedVolumes` declaration requires a unique stable `key` and `kind`, where `kind` is `cache` or `data`. The collection defaults to `[]`.

Every declared volume is workspace-scoped. Each workspace receives independent volume instances, so a primary workspace and its isolated workspaces never share a declared volume. Instances survive container stop, start, and rebuild. Removal follows workspace removal and the configured cleanup policy. This contract defines configuration semantics only; Docker behavior, concrete volume naming, quota enforcement, and backup implementation belong to later milestones.

### Development environment

`developmentEnvironment.source` is required and is exactly one of:

- `{ "kind": "preset", "presetKey": string, "runtimeVersion": string }`;
- `{ "kind": "image", "imageReference": string }`;
- `{ "kind": "dockerfile", "dockerfilePath": string, "contextPath": string }`, where `contextPath` is optional in input and defaults to `"."`.

The containing object also has:

- optional `containerUser`, default `null`, meaning the selected source default;
- optional `passwordlessSudo`, default `false`;
- optional `workingDirectory`, whose only v1 value is `/workspace` and whose default is `/workspace`;
- optional `environment` object, default `{}`, whose property names map to environment bindings;
- optional unordered `ports`, default `[]`; each item requires a unique `name` and `containerPort`, with optional `protocol` fixed to `tcp` in v1 and defaulting to `tcp`;
- optional unordered `volumes`, default `[]`; each item requires a `volumeKey` naming a top-level declared named volume and a container `mountPath`;
- optional ordered `setupSteps`, default `[]`; each item is a command as defined below;
- optional `rebuildPolicy`, one of `manual` or `on-revision-change`, default `manual`.

The development-environment `environment` is inherited by setup steps, normal tasks, terminals, and AI sessions. A setup-step or task command environment overlays inherited entries with the same name. Environment binding references, including secrets, remain unresolved in configuration and are resolved only at execution time.

Project Options cannot represent arbitrary host mounts, Docker sockets, privileged mode, host networking, host PID mode, host devices, or arbitrary host-port publication. Their appearance as unknown keys is invalid.

### Commands and setup steps

A command is a strict object with:

- required non-empty `executable`;
- optional ordered string array `args`, default `[]`;
- optional worktree-relative `workingDirectory`, default `"."`;
- optional `environment` object, default `{}`, whose property names map to environment bindings.

No shell is implied. A future shell-command capability is excluded from v1. Setup steps retain array order and run only when explicitly requested during environment creation or rebuild; they do not run on every start.

### Tasks

Each task requires a unique stable `key`, `displayName`, and `command`. It also has:

- `interactive`, default `false`;
- `longRunning`, default `false`;
- `timeoutSeconds`, default `null`, meaning no task-specific override;
- `concurrencyPolicy`, one of `reject`, `allow`, or `replace`, default `reject`;
- unordered unique integer `successExitCodes`, default `[0]`;
- `logRetentionDays`, default `null`, meaning inherit the project resource policy.

### Supporting services

Each service requires a unique stable `key` and `imageReference`. It also has:

- `environment`, default `{}`, using the bindings below;
- unordered `volumes`, default `[]`; each item requires a `volumeKey` naming a top-level declared named volume and a container `mountPath`;
- unordered `ports`, default `[]`; each item requires a unique `name` and `containerPort`, with optional `protocol` fixed to `tcp` in v1 and defaulting to `tcp`;
- `entrypoint`, default `null`, or an ordered non-empty string array;
- `command`, default `null`, or an ordered string array;
- `workingDirectory`, default `null`;
- `healthCheck`, default `null`, or exactly one of:
  - `{ "kind": "http", "portName": string, "path": string, "expectedStatuses": integer[] }`, with `path` default `/` and unordered `expectedStatuses` default `[200]`;
  - `{ "kind": "tcp", "portName": string }`;
  - `{ "kind": "command", "command": Command }`;
- unordered `dependsOn`, default `[]`; each item requires a unique `serviceKey` and a `condition` of `started` or `healthy`;
- `resources`, default `{ "cpuMillicores": null, "memoryBytes": null }`; `null` means inherit the administrator policy.

Services remain internal to the workspace network unless referenced by a preview. They cannot publish arbitrary host ports.

Service `entrypoint` and `command` are structured container-runtime arrays. Their order is significant, and neither value implies a shell.

### Previews

Each preview requires a unique stable `key`, `displayName`, `target`, `containerPort`, `domainBaseId`, and `hostnamePattern`.

`target` is either `{ "kind": "workspace" }` or `{ "kind": "service", "serviceKey": string }`. Other fields are:

- `protocol`, fixed to `http` in v1 and defaulting to `http`;
- `healthPath`, default `/`;
- unordered unique `healthStatuses`, default `[200]`;
- `startupTimeoutSeconds`, default `60`;
- `webSocketForwarding`, default `true`.

The hostname pattern is one label and may use only `{project}`, `{workspace}`, `{preview}`, and `{shortId}`. The domain base is referenced by ID; the approved domain value is not embedded in Project Options. A workspace-targeted preview's `containerPort` must match a declared `developmentEnvironment.ports` entry. A service-targeted preview's `containerPort` must match a declared port on the referenced service.

### Environment variables and secret references

An environment binding is exactly one of these categories:

- literal: `{ "kind": "literal", "value": string }`;
- administrator-approved host value: `{ "kind": "host", "variable": string }`;
- secret reference: `{ "kind": "secret", "secretId": UUIDv7 }`;
- DevSpace-generated value: `{ "kind": "generated", "valueKey": string }`;
- service connection value: `{ "kind": "service", "serviceKey": string, "valueKey": string }`.

Secret values never appear in configuration JSON and are never returned to the browser after entry. Only canonical lowercase UUIDv7 secret IDs are stored. Host variables and generated value keys are identifiers from administrator-owned registries; configuration cannot supply their values.

### AI profile

When non-null, `aiProfile` requires:

- `providerKey` and `executableProfileKey`, both registry keys;
- ordered `fixedArgs`, default `[]`;
- unordered unique `credentialSecretIds`, default `[]`, containing only UUIDv7 secret references;
- worktree-relative `instructionsFilePath`, default `null`;
- `networkDisclosureAcknowledged`, default `false`.

Activation requires `networkDisclosureAcknowledged` to be `true`. The browser selects a profile and never defines its executable. Credential values are not configuration fields.

### Resources and cleanup

`resources` is materialized with these fields:

- `cpuMillicores`, `memoryBytes`, `pidLimit`, and `maxNamedVolumeBytes`, each default `null` to inherit administrator policy;
- `logRetentionDays` and `stoppedWorkspaceRetentionDays`, each default `null` to inherit administrator policy;
- `automaticStopMinutes`, default `null`, meaning disabled unless administrator policy imposes a limit;
- `maxConcurrentWorkspaces`, default `null`, meaning inherit administrator policy.

Values supplied in these fields must be positive integers. Project Options can narrow administrator limits but cannot expand them; that policy check is a runtime refinement.

## Collection semantics and normalization

Ordered collections retain their order and order affects the revision hash: setup steps, command arguments, service entrypoint and command arrays, and AI fixed arguments.

Keyed collections are semantically unordered and are sorted by canonical key before hashing: named volumes, tasks, services, and previews. Other unordered collections are sorted by their declared identity: development-environment and service volumes by `(volumeKey, mountPath)`, development-environment and service ports by `(name, containerPort)`, dependencies by `serviceKey`, secret IDs lexically, and status/exit-code sets numerically. Duplicates are invalid rather than discarded. Environment maps are JSON objects and JCS orders their keys.

No general trimming, Unicode normalization, URL rewriting, path rewriting, or case folding occurs. Validators require canonical lowercase values where specified and reject leading/trailing whitespace where it would be ambiguous. Strings must be valid Unicode without lone surrogates.

## Cross-reference and activation validation

Runtime refinements enforce all of the following:

- stable keys are unique within their collection;
- every development-environment and service volume names a top-level declared named volume;
- port names are unique within the development environment and within each service;
- every service dependency names a different declared service, and the dependency graph is acyclic;
- every service health-check `portName` names a port on that service;
- every preview service target exists;
- every workspace-targeted preview port exists in `developmentEnvironment.ports`;
- every service-targeted preview port exists on its referenced service;
- every service-connection environment binding names an existing service and supported connection value;
- every referenced secret, domain base, host variable, generated value, provider, and executable profile exists and is authorized for the project;
- `interactive`, `longRunning`, `timeoutSeconds`, and `concurrencyPolicy` are independent task
  fields: every structurally valid combination is supported in v1, with no additional cross-field
  relationship imposed. `timeoutSeconds`, when non-null, still obeys its positive-integer bounds;
  task execution semantics belong to a later runtime milestone;
- administrator resource limits are not exceeded;
- AI network disclosure is acknowledged before activation.

Drafts may be stored with unresolved registry references only when their validation result records the issues. Activation requires every structural and cross-reference validation to succeed.

## Canonicalization and revision hash

The final canonical Project Options v1 revision representation is limited to exactly 2,097,152
UTF-8 bytes. The limit is measured after F07 parsing and default materialization, accepted semantic
normalization, JCS canonicalization, and UTF-8 encoding. Exactly 2,097,152 bytes is valid;
2,097,153 bytes is invalid. This is a revision-representation constraint enforced by
`canonicalizeProjectOptionsV1`, `canonicalizeProjectOptionsV1Bytes`, and `hashProjectOptionsV1`.
It is not a base F07 structural-object constraint: `parseProjectOptionsV1` does not compute or
enforce canonical byte size.

Canonicalization is performed only after successful v1 validation:

1. Strictly parse the input and reject unknown keys and invalid scalar forms.
2. Materialize every default described in this specification, including nested defaults and `null` inheritance markers.
3. Apply the collection ordering rules above. Do not otherwise rewrite string or numeric values.
4. Serialize the resulting JSON value using RFC 8785/JCS and UTF-8.

The revision-hash input is the UTF-8 byte prefix `devspace/project-options-revision/v1` followed by a zero byte and the canonical JSON bytes. SHA-256 is applied to that complete byte sequence. The stored and wire representation is:

```text
sha256-jcs-v1:<64 lowercase hexadecimal characters>
```

The hash identifies the complete default-materialized runtime-configuration revision. It excludes project metadata supplied separately to runtime-plan compilation, workspace display names, and database metadata such as revision ID, revision number, source, author, lifecycle state, and timestamps.

## JSON Schema portability boundary

Generated JSON Schema represents strict object shapes, required fields, defaults as annotations, scalar bounds and patterns, discriminated binding/source/health-check variants, service startup override shapes, constants, and locally checkable array uniqueness where JSON Schema can express it.

Runtime Zod refinements remain authoritative for uniqueness by stable key or port name, sorting/canonicalization, graph acyclicity, named-volume mount references, references across collections or administrator registries, preview target and declared-port matching, resource-policy comparisons, activation-only rules, and revision hashing. There is no task flag/timeout/concurrency combination refinement in v1; those four task fields are validated independently. Fixtures must cover both portable constraints and runtime-only refinements. Defaults are applied by the runtime parser; JSON Schema `default` annotations do not mutate input.

## Revision lifecycle and portability

```text
draft -> active -> superseded
   \-> rejected
```

Only one active revision exists per project. Activating a revision supersedes the former active revision but does not rewrite existing workspace pins.

A future Export action produces the canonical JSON defined above. Import creates a draft and requires review. Repository contents never auto-activate imported configuration.
