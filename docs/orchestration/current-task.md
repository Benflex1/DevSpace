# Current Task

## Status

The blocking M0-F06 approved-preview-base binding correction was implemented on 2026-07-15;
focused independent security re-review is pending. The slice is not accepted or committed. Do not
begin M0-F07.

## Completed task

Implement pure Milestone 0 security validation primitives without filesystem, Git, DNS, gateway,
runtime, Project Options schema, or other M0-F07 behavior.

## Deliverables

- Four distinct worktree-relative path brands and validators share a private platform-independent
  lexical parser while preserving field-specific root/file rules.
- Claimed already-canonical absolute POSIX paths use a separate brand and a segment-aware
  `equal`/`descendant`/`outside` relation without authorization or symlink-safety claims.
- Git branch shorthand validation implements strict lexical boundaries without Git invocation or
  existence/ref-resolution claims.
- Lower-case ASCII DNS labels, trusted approved preview bases, non-repeating allowlisted one-label
  patterns, validated placeholder inputs, and final hostname composition enforce label and FQDN
  limits without DNS or gateway activity.
- Approved preview bases are immutable constructor-created opaque ID/domain pairs; an opaque
  package-owned registry snapshots associations, rejects duplicate IDs and structural forgeries,
  and prevents callers from replacing the domain selected by an exact requested ID.
- L-02 covers a forged approved base created by copying every own string and symbol key and
  descriptor from a genuine base before changing its visible association.
- Composition defensively revalidates the internally selected domain, and the independently
  encoded accepted error inventory contains exactly 62 reachable stable codes.
- Expected failures use immutable discriminated results with a frozen closed error-code set,
  category, original input, field, policy, and structured details.
- Table-driven Linux tests include POSIX traversal and Windows drive, rooted, UNC, device, and
  backslash-hostile fixtures; compile-time tests enforce brand separation and public export scope.
- Package documentation records lexical-only, symlink, TOCTOU, Git, DNS, and runtime non-goals.

## Previous completed task

M0-F05 review corrections were implemented on 2026-07-14.

## M0-F05 deliverables

- Closed state unions and private, deeply frozen exhaustive transition definitions cover all 17
  specified lifecycles.
- Lifecycle-specific pure transitions and contextual guards return stable discriminated errors.
- Specification-derived fixtures cover all 690 ordered state pairs plus every guarded edge and
  invalid-edge precedence case.

## Previous completed task

M0-F04 completed on 2026-07-14.

## Completed task

Establish the real TypeScript unit-test and fixture harness without adding product behavior or beginning lifecycle, security, Project Options, contracts, or database implementation.

## Deliverables

- Vitest 4 named-project configuration runs all eight active workspaces in deterministic Node mode through non-watch `vitest run`.
- Every active workspace has explicit no-emit test typechecking; package builds exclude test files from `dist/`.
- Private development-only `@devspace/testkit` provides tested temporary-directory and JSON-fixture helpers.
- Workspace graph and ESLint checks enforce testkit dependency and import boundaries.
- V8 coverage is available through `test:coverage` and writes only to ignored output.

## Previous completed task

M0-F03 completed on 2026-07-14.

## Completed task

Establish real strict TypeScript compilation, package builds, and semantic linting without adding product behavior or a test framework.

## Deliverables

- Root and package TypeScript configurations preserve strictness, use NodeNext ESM, and separate no-emit typechecking from emitting composite builds.
- No-emit typechecking uses public-package-to-source path mappings so cross-package imports work without prior build output.
- All active packages have real typecheck and build scripts; production builds emit ESM JavaScript and declarations without test files.
- Flat-config ESLint uses type-aware TypeScript rules, ESM checks, and accepted source-import boundaries.

## Previous completed task

M0-F02 completed on 2026-07-14.

## M0-F02 deliverables

Create the real pnpm 11 workspace and the accepted Milestone 0 app/package boundaries without adding product behavior.

### Recorded outcomes

- Node.js and pnpm baselines are checked in through the root engine range, `.nvmrc`, and `packageManager` field.
- `apps/web`, `apps/agent`, and the five required production packages have private ESM manifests and empty source roots.
- Library packages expose future `dist/` entry points; application packages remain private executable boundaries.
- Internal production dependencies use `workspace:*` and follow the accepted ownership graph.
- `tooling/check-workspace-graph.mjs` checks expected and deferred package manifests, dependency direction, unknown internal packages, application edges, and cycles.
- Line-ending policy and package ownership README corrections are recorded.

## M0-F01 deliverables

Close the material representation and specification blockers in the Milestone 0 foundation plan, including the four orchestration-review cross-specification corrections, without implementing product behavior or changing generated artifacts.

### Recorded outcomes

- ADR 013 records the runtime, package-manager, ESM, schema-source, ID, timestamp, canonicalization, hashing, agent transport, and cursor-recovery decisions.
- Project Options v1 separates project General metadata from immutable runtime revisions and defines named volumes, complete development/service container configuration, declared-port preview validation, defaults, canonicalization, and runtime refinements.
- Database v1 makes the project row authoritative for project/repository metadata, the workspace row authoritative for workspace display names, and General edits optimistic through `projects.row_version`.
- Agent API v1 defines REST-over-UDS envelopes, web-created operation IDs, the agent's narrow durable execution/idempotency journal, request hashing, events beginning at sequence one, cursor-only sequence zero, replay, and snapshot recovery.
- Lifecycle v1 preserves web ownership of SQLite operation state while using the agent journal only for safe acceptance, replay, and recovery.
- The foundation plan now uses the project model policy, grouped chats, corrected package dependencies, deferred package creation, and Linux-only initial CI with hostile cross-platform path fixtures.

## Next task in this chat

Focused independent security re-review of the M0-F06 approved-base binding correction and L-02
regression. Do not begin M0-F07 yet.
