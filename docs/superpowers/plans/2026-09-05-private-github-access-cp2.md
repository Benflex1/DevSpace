# Private GitHub Access Checkpoint 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the browser-usable CP2 private GitHub repository slice with immutable source authority, live installation proof, exact read-only Git tokens, askpass brokering, managed clone/fetch/rename recovery, Web persistence, and browser controls.

**Architecture:** Web proves actor ownership through the existing connection-attempt relationship and atomically stores safe project metadata. The Agent re-proves live GitHub installation authority, owns the token lease lifecycle, and uses a short private askpass broker for one exact Git process. Managed ownership records retain the exact `{ connectionId, repositoryId }` source locator and versioned clean-origin transition state.

**Tech Stack:** TypeScript 7, Zod, Node HTTP/Unix sockets, SQLite/Drizzle, native C helper built statically with the existing Agent helper precedent, Git, Vitest, and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-05-private-github-access-cp2-design.md`

## Global Constraints

- Browser-supplied GitHub owner, repository name, full name, and URL never grant private-source authority.
- GitHub decimal IDs remain canonical validated strings internally and are emitted as raw JSON numbers only by the bounded exact-token serializer.
- Installation tokens never enter browser/API JSON, SQLite, durable Agent files, operation journals, logs, URLs, argv, parent environments, Git config, workspace state, or container state.
- Public HTTPS onboarding, inspection, managed store, fetch, and workspace paths remain behaviorally unchanged.
- CP1 lease serialization, 70-minute uncertain-mint guard, cleanup-degraded state, restart conservatism, and no token pooling remain intact.
- No Git push, disconnect/revocation UX, installation deletion, provider fallback, webhook, GitHub Enterprise, or CP3 behavior.

### Task 1: Extend source, GitHub, and failure contracts

**Files:**
- Modify: `packages/contracts/src/github-app.ts`
- Modify: `packages/contracts/src/shapes.ts`
- Modify: `packages/contracts/src/github-app-endpoints.ts`
- Modify: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/execution-failures.ts`
- Modify: `packages/contracts/src/endpoints.ts`
- Test: `packages/contracts/src/github-app.test.ts`, `packages/contracts/src/inventory.test.ts`, and relevant contract tests

**Interfaces:**
- Produces `sourceLocatorSchema` support for `{ kind: "github-app"; connectionId; repositoryId }`.
- Produces `github.installation.refresh` and exact `github.repositories.resolve` Agent descriptors.
- Produces discriminated GitHub source inspection data and stable safe failure codes.

- [ ] **Step 1: Write failing contract tests** for the github-app locator, URL-free strict requests, IDs above `Number.MAX_SAFE_INTEGER`, refresh/resolve endpoint inventory, GitHub inspection discrimination, and failure applicability on `project.managed-store.create` and `project.fetch`.
- [ ] **Step 2: Run focused contract tests** with `pnpm exec vitest run packages/contracts/src/github-app.test.ts packages/contracts/src/inventory.test.ts` and confirm failures are due to missing CP2 schemas/descriptors.
- [ ] **Step 3: Implement minimal schemas and endpoint descriptors** while retaining public remote schemas and route behavior.
- [ ] **Step 4: Run the focused tests and `pnpm contracts:check`** until green; regenerate the Agent API JSON schema through the normal contract build path.
- [ ] **Step 5: Commit** `feat: extend contracts for private GitHub sources`.

### Task 2: Replace unsafe GitHub JSON handling and factor live authority/token transactions

**Files:**
- Modify: `apps/agent/src/github-app.ts`
- Test: `apps/agent/src/github-app.test.ts`

**Interfaces:**
- Produces a bounded lossless upstream JSON parser and bounded token request serializer.
- Produces `refreshInstallation`, `resolveRepository`, and an internal exact-token transaction used by listing and private Git.
- Preserves existing `GithubAppAuthority` public methods and CP1 test seams.

- [ ] **Step 1: Write failing tests** for raw numeric IDs larger than `Number.MAX_SAFE_INTEGER`, exact numeric `repository_ids`, rejection of string IDs in the serialized request, foreign/missing/duplicate scoped repositories, contents write/missing permission, stale snapshot refresh, removed/suspended installation, and actor-independent Agent connection binding.
- [ ] **Step 2: Run `pnpm exec vitest run apps/agent/src/github-app.test.ts`** and verify the new tests fail against the generic regex parser and CP1 snapshot reuse.
- [ ] **Step 3: Implement a bounded JSON tokenizer** that preserves every numeric lexeme as validated decimal text, and a discriminated body serializer whose only raw numeric insertion is the validated repository ID.
- [ ] **Step 4: Implement live `/app` plus exact installation proof** and atomic safe binding persistence while retaining cleanup-degraded state; return stable internal failure reasons without upstream bodies.
- [ ] **Step 5: Implement metadata listing and exact repository resolution through the shared serialized token transaction** with contents permission checks before private Git minting.
- [ ] **Step 6: Run the full GitHub Agent test file**, then commit `feat: add live exact GitHub repository authority`.

### Task 3: Build the native askpass helper and private broker

**Files:**
- Create: `apps/agent/native/devspace-git-askpass.c`
- Create: `tooling/build-github-askpass-helper.mjs`
- Modify: `apps/agent/package.json`
- Create: `apps/agent/src/github-askpass.ts`
- Modify: `apps/agent/src/external-execution.ts`
- Test: `apps/agent/src/github-askpass.test.ts`, native helper integration tests

**Interfaces:**
- Produces a broker lifecycle with `register`, `settle`, `start`, and `stop` behavior entirely in Agent memory/runtime state.
- Produces a trusted absolute helper path under `apps/agent/dist/native/devspace-git-askpass` for source and compiled execution.
- Produces broker protocol frames capped below the configured maximum and accepts only one username and one password response per capability.

- [ ] **Step 1: Write failing broker tests** for XDG runtime selection, `/run/user/<uid>` selection, unpredictable `/tmp` fallback, long durable state paths, stale sockets, identity changes, wrong/expired capabilities, duplicate prompts, unknown prompts, malformed/oversized frames, execution mismatch, and deterministic cleanup.
- [ ] **Step 2: Run `pnpm exec vitest run apps/agent/src/github-askpass.test.ts`** and confirm the broker/helper symbols and protocol behavior are absent.
- [ ] **Step 3: Implement the native helper and static build script** using bounded binary frames, silent nonzero failure, and stdout-only credential delivery.
- [ ] **Step 4: Implement private runtime directory/socket lifecycle** with owner/mode/lstat checks, active probing, stale removal only after identity recheck, and a bounded pathname error.
- [ ] **Step 5: Bind capabilities to operation, connection, repository, execution/process identity, deadline, and prompt allowance; remove registrations in `finally` after process settlement.
- [ ] **Step 6: Run the broker tests and `pnpm --filter @devspace/agent run build:helper`; commit `feat: add private Git askpass broker`.

### Task 4: Harden Git execution and integrate authenticated inspection

**Files:**
- Modify: `apps/agent/src/managed-workspaces.ts`
- Modify: `apps/agent/src/git-inspector.ts`
- Modify: `apps/agent/src/external-execution.ts`
- Modify: `apps/agent/src/server.ts`
- Test: `apps/agent/src/git-inspector.security.test.ts`, `apps/agent/src/server.security.test.ts`, `apps/agent/src/managed-workspaces.test.ts`

**Interfaces:**
- Produces one positive authenticated-Git environment builder with trusted askpass path and nonsecret argv config.
- Extends `project.source.inspect` to dispatch github-app locators while keeping public remote inspection unauthenticated.

- [ ] **Step 1: Write failing hostile-environment tests** proving inherited askpass, SSH, config, credential-helper, trace, proxy, HOME/XDG, and alternate-config values cannot affect authenticated Git or capture credentials.
- [ ] **Step 2: Run the focused security tests** and confirm the inherited-environment attack cases fail against CP1's partial environment.
- [ ] **Step 3: Implement allowlisted environment and command-level config** (`credential.helper=`, `credential.useHttpPath=true`, hooks/submodules/protocol/redirect controls, `GIT_TERMINAL_PROMPT=0`, trusted helper, `/bin/false` SSH askpass, controlled HOME/XDG).
- [ ] **Step 4: Route github-app source inspection through exact live resolution and askpass-backed `git ls-remote --symref ... HEAD`; keep local/public paths credential-free.
- [ ] **Step 5: Run focused security and inspection tests; commit `feat: harden authenticated Git execution`.

### Task 5: Extend Agent managed stores, fetch, ownership, and rename recovery

**Files:**
- Modify: `apps/agent/src/managed-workspaces.ts`
- Modify: `apps/agent/src/operation-executor.ts`
- Test: `apps/agent/src/managed-workspaces.test.ts`, `apps/agent/src/operation-executor.test.ts`, `apps/agent/src/abrupt-restart.test.ts`

**Interfaces:**
- Produces versioned ownership records retaining exact GitHub source identity and pending origin transition.
- Extends managed clone and fetch to use fresh exact tokens only for network Git operations.
- Keeps local workspace creation/inspection/update-ref credential-free.

- [ ] **Step 1: Write failing tests** for private clone, initial fetch, later fetch, clean remote URL, foreign source identity, removed/unselected repository, authentication rejection, local-operation no-token behavior, restart-safe pending origin pairs, and third-URL conflict.
- [ ] **Step 2: Run the managed workspace tests** and confirm CP1 rejects github-app sources or lacks private auth.
- [ ] **Step 3: Implement github-app clone/fetch/inspection branches** using the shared authority and broker, with stable failure mapping and cleanup independent from primary Git success.
- [ ] **Step 4: Implement versioned origin transition and public v1 compatibility** with exact old/new restart recovery.
- [ ] **Step 5: Run managed workspace, restart, operation executor, and relevant integration tests; commit `feat: support immutable GitHub managed sources`.

### Task 6: Add safe Web persistence and actor-bound queries

**Files:**
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/migrator.ts`
- Create: `packages/database/src/migrations/0007_github_private_sources.sql` (generated and reviewed)
- Modify: `packages/database/src/migrations/meta/_journal.json` and generated snapshot
- Modify: `apps/web/src/server/database.ts`
- Test: `packages/database/src/schema.test.ts`, `packages/database/src/migration.test.ts`, `apps/web/src/server/database.test.ts`

**Interfaces:**
- Produces `projectGithubSources` with no secret/token fields and exact source identity.
- Produces actor-bound connection lookup, atomic project-plus-source registration, safe metadata refresh, immutable project source loading, and fresh later-fetch operation allocation.

- [ ] **Step 1: Write failing database tests** for schema constraints/no-secret columns, connection actor ownership, wrong/non-owned connections, atomic project/source rollback, branch separation, metadata refresh, and active-versus-terminal fetch operation reuse.
- [ ] **Step 2: Run focused database tests** and verify the table/query APIs and migration version are missing.
- [ ] **Step 3: Add Drizzle schema and generate migration artifacts**; update `latestSchemaVersion`, journal, snapshot, table inventory, and schema documentation.
- [ ] **Step 4: Implement actor-join invariant and transactional project/source methods**; validate canonical safe metadata and preserve `projects.default_branch` as the selected branch.
- [ ] **Step 5: Implement later-fetch operation allocation and source metadata refresh** without changing existing setup operation semantics.
- [ ] **Step 6: Run `pnpm db:migrate:test`, `pnpm db:check`, and focused Web database tests; commit `feat: persist immutable GitHub project sources`.

### Task 7: Add Web Agent client, refresh/list/resolve routes, onboarding, and setup plumbing

**Files:**
- Modify: `apps/web/src/server/agent-client.ts`
- Modify: `apps/web/src/server/onboarding.ts`
- Modify: `apps/web/src/server/workspace-setup.ts`
- Modify: `apps/web/src/server/failure-policy.ts`
- Modify: `apps/web/src/server/user-facing-failure.ts`
- Modify: `apps/web/src/app/api/projects/route.ts`
- Create: `apps/web/src/app/api/integrations/github/refresh/route.ts`
- Modify: `apps/web/src/app/api/integrations/github/repositories/route.ts`
- Modify: `apps/web/src/app/api/integrations/github/connection/route.ts`
- Modify: `apps/web/src/app/api/integrations/github/routes.test.ts`
- Modify: `apps/web/src/app/api/projects/route.test.ts`
- Modify: `apps/web/src/server/onboarding.test.ts`

**Interfaces:**
- Produces actor-authenticated/CSRF-protected refresh and identity-only registration paths.
- Produces setup requests carrying the persisted github-app locator rather than a browser URL.

- [ ] **Step 1: Write failing Web tests** for non-owned connection IDs, refresh authorization/CSRF, stale permission refresh, repository resolve, identity-only project registration, archived/disabled rejection, atomic setup source selection, and stable safe failure messages.
- [ ] **Step 2: Run the focused Web route/onboarding tests** and verify the new flow is absent.
- [ ] **Step 3: Add Agent client methods and route-specific safe error projection** without exposing upstream details.
- [ ] **Step 4: Extend onboarding parsing as a strict HTTPS-or-GitHub discriminated input** and resolve GitHub metadata through the Agent before atomic database registration.
- [ ] **Step 5: Load immutable project source in setup and pass it to managed-store creation; preserve normal Project Options, primary workspace, and runtime setup operations.
- [ ] **Step 6: Run focused Web tests and commit `feat: add actor-bound GitHub onboarding`.

### Task 8: Add later fetch route and coherent Add Project/Workbench UI

**Files:**
- Modify: `apps/web/src/app/project-form.tsx`
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/app/github-app-card.tsx` or fold its behavior into the Add Project surface
- Modify: `apps/web/src/app/project-workbench.tsx`
- Modify: `apps/web/src/app/projects/[projectId]/page.tsx`
- Create: `apps/web/src/app/api/projects/[projectId]/fetch/route.ts`
- Test: component/source tests, route tests, and `e2e/project-onboarding.spec.ts`

**Interfaces:**
- Produces one Add Project surface with HTTPS and Connected GitHub repository modes.
- Produces a minimal `Fetch repository` Workbench action with operation reconciliation.

- [ ] **Step 1: Write failing route/component/browser tests** for refresh/list/select/register/setup/start and later-fetch active retry, terminal retry, permission/removal messages, and unchanged public onboarding.
- [ ] **Step 2: Run focused Web/browser tests** and confirm the controls and route are absent.
- [ ] **Step 3: Implement the unified form** with verified account, Contents status, refresh control, repository identity selection, archived/disabled disabling, safe suggestions, and no URL in GitHub submission.
- [ ] **Step 4: Implement the authenticated fetch route** using the database operation helper and existing snapshot/reconciliation machinery; make setup fetch distinct from later fetch.
- [ ] **Step 5: Add the Workbench action and safe status/error display; run focused Playwright/browser tests.
- [ ] **Step 6: Commit `feat: add private GitHub browser workflow`.

### Task 9: Reconcile documentation and add leakage/integration evidence

**Files:**
- Modify: `docs/current-state.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/specs/agent-api-v1.md`
- Modify: `docs/specs/database-v1.md`
- Test: new/extended canary and local authenticated-Git integration suites

- [ ] **Step 1: Write failing canary tests** that inspect browser JSON, SQLite, private files, operation journal, leases, URLs, argv, parent environment, Git config, stdout/stderr, output files, logs/errors, and workspace/container state for a deterministic token.
- [ ] **Step 2: Run the leakage/integration tests** and confirm the new surfaces are not yet covered or fail.
- [ ] **Step 3: Implement the real local HTTPS Git fixture and canary assertions** without printing the canary in diagnostics.
- [ ] **Step 4: Reconcile CP1 documentation with merged PR #44, canonical merge commit, validated CP1 head/tree equivalence, completed local/dev acceptance, and accurate CP2 status; document explicit exclusions and pending real-provider gate.
- [ ] **Step 5: Run the focused integration suite and commit `docs: reconcile GitHub access checkpoint status`.

### Task 10: Full verification, review, push, and draft PR

**Files:**
- Modify only files required by verification corrections.

- [ ] **Step 1: Run `git diff --check` and focused security, Agent, database, Web, and Playwright suites.
- [ ] **Step 2: Run the complete repository contract exactly:**
  ```bash
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
  ```
- [ ] **Step 3: Review all changed files and run the verification-before-completion checklist; fix failures without weakening tests or invariants.
- [ ] **Step 4: Commit the final coherent implementation, push `feat/private-github-access-cp2`, and create one draft PR targeting `main`.
- [ ] **Step 5: Verify the PR remains draft, no merge or deployment occurred, and capture the exact requested Git outputs for the final report.

