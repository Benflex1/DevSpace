# DevSpace Private GitHub Access CP3B — Explicit Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a confirmed, same-branch explicit push for GitHub App-backed managed workspaces without persisting reusable Git credentials or automatically retrying an uncertain remote write.

**Architecture:** Web prepares and durably records a server-derived push intent in the existing operations.progressJson; confirmation sends only the intent ID from the browser and Web submits a strict Agent project.push request. The Agent validates managed workspace state, uses a distinct exact-repository contents: write token transaction, reuses the CP3A lifecycle launch fence, and terminalizes interrupted push journal records as GITHUB_PUSH_OUTCOME_UNCERTAIN instead of resuming them.

**Tech Stack:** TypeScript, Zod, Vitest, Next.js App Router, Drizzle/SQLite, Node child-process Git execution, existing GitHub App installation-token and askpass transports.

**Spec:** docs/superpowers/specs/2026-09-07-private-github-access-cp3b-push-design.md

## Global Constraints

- Browser requests contain only push action and opaque operation/intent IDs; branch, commit, URL, remote, refspec, and force options are Web/Agent-owned.
- Push is restricted to an actor-owned GitHub App source and a managed primary workspace in the temporary Web UX; public clone/fetch/inspect behavior remains unchanged.
- The only push refspec is <captured-commit>:refs/heads/<captured-branch> on the live authority-resolved HTTPS URL for managed origin.
- Push requests exact selected-repository contents: write; read/list/resolve/clone/fetch requests retain their existing read-only scopes.
- Tokens are Agent-only, short-lived, in-memory, askpass-delivered, and settled through the existing lease model.
- A disconnected or stale lifecycle generation must fail before token mint or Git launch; reconnect never resumes an old push.
- A nonterminal project.push journal record is durably changed to terminal GITHUB_PUSH_OUTCOME_UNCERTAIN on Agent restart.
- No force push, tags, deletion, arbitrary refspec/remote/branch, upstream mutation, push options, submodule credentials, hooks, merge/rebase UI, PR, PAT/OAuth, provider abstraction, or workbench redesign.

---

### Task 1: Add strict CP3B contracts and failure inventory

**Files:**
- Modify: packages/contracts/src/shapes.ts
- Modify: packages/contracts/src/endpoints.ts
- Modify: packages/contracts/src/errors.ts
- Modify: packages/contracts/src/execution-failures.ts
- Modify: packages/contracts/src/accepted-matrices.test.ts
- Modify: packages/contracts/src/inventory.test.ts
- Modify: packages/contracts/src/f10-inventory.test.ts
- Modify: packages/contracts/src/index.test.ts

**Interfaces:**
- Produce projectPushDataSchema and ProjectPushData with strict fields { projectId, workspaceId, source, branchName, commitOid, githubAuthorityGeneration }.
- Produce project.push at POST /v1/projects/push, as a journaled mutation with a 202 mutation receipt.
- Produce terminal failure codes GITHUB_PUSH_INTENT_STALE, GITHUB_PUSH_NON_FAST_FORWARD, and GITHUB_PUSH_OUTCOME_UNCERTAIN, with statuses 409, 409, and 503.

- [ ] **Step 1: Write the failing contract tests**

Add project.push to the independent endpoint matrix with its exact route and mutation flag. Add request/response fixtures and assertions rejecting a remote source, invalid branch/OID, missing generation, and extra fields. Add the three failure-code status assertions.

- [ ] **Step 2: Run the contract tests and verify the expected failure**

~~~text
pnpm exec vitest run packages/contracts/src/accepted-matrices.test.ts packages/contracts/src/inventory.test.ts packages/contracts/src/f10-inventory.test.ts packages/contracts/src/index.test.ts
~~~

Expected: FAIL because the endpoint, schema, and failure inventory do not exist.

- [ ] **Step 3: Implement the minimal contract inventory**

Define the strict schema with existing UUID, Git branch/OID, and GitHub decimal-ID schemas. Add the endpoint and errors. Update the executable failure-code and per-operation applicability arrays, including inventory counts.

- [ ] **Step 4: Run the same contract tests and verify green**

Confirm all four contract test files pass with zero failures.

- [ ] **Step 5: Commit**

~~~text
git add packages/contracts/src
git commit -m "feat: add explicit push contracts"
~~~

### Task 2: Add a separate exact write-token authority path

**Files:**
- Modify: apps/agent/src/github-app.ts
- Modify: apps/agent/src/github-app.test.ts
- Modify: apps/agent/src/managed-workspaces.github-app.test.ts

**Interfaces:**
- Produce GithubAppAuthority.withExactRepositoryWriteToken<T>(input, operation, operationId?).
- Preserve withExactRepositoryToken<T> as a read-only path serializing and validating contents: read.
- Serialize the write request only as exact selected repository IDs plus contents: write; require the retained binding and returned scope to advertise write authority.

- [ ] **Step 1: Write the failing authority tests**

Bind a write-capable installation and assert the token request body is exactly {"repository_ids":[9007199254740993],"permissions":{"contents":"write"}}, the callback receives the in-memory token, and the decimal repository ID is preserved. Add a read regression for the unchanged contents: read body. Add a missing-write-permission test that fails before token mint and a generation race test proving a returned token cannot reach the callback after admission is lost.

- [ ] **Step 2: Run the focused authority tests and verify the expected failure**

~~~text
pnpm exec vitest run apps/agent/src/github-app.test.ts apps/agent/src/managed-workspaces.github-app.test.ts
~~~

Expected: FAIL because no write method/body/validation exists.

- [ ] **Step 3: Implement the isolated write path**

Add one exact write-only serializer variant, generalize exact-scope validation by required permission, add the interface method and implementation, and map its internal failures through the existing safe failure conversion. Do not alter read callers or their serialized body.

- [ ] **Step 4: Run the focused authority tests and verify green**

Confirm read/write scope, lease settlement, and generation-race tests pass.

- [ ] **Step 5: Commit**

~~~text
git add apps/agent/src/github-app.ts apps/agent/src/github-app.test.ts apps/agent/src/managed-workspaces.github-app.test.ts
git commit -m "feat: add exact GitHub write token authority"
~~~

### Task 3: Add safe push Git execution and state-drift guards

**Files:**
- Modify: apps/agent/src/authenticated-git-failure.ts
- Modify: apps/agent/src/authenticated-git-failure.test.ts
- Modify: apps/agent/src/external-execution.ts
- Modify: apps/agent/src/external-execution.test.ts
- Modify: apps/agent/src/managed-workspaces.ts
- Modify: apps/agent/src/managed-workspaces.github-app.test.ts

**Interfaces:**
- Produce ManagedWorkspaces.push(input: ProjectPushData, operationId: string): Promise<void>.
- Add external execution role project-push and bind it to project.push.
- Verify managed ownership, exact source identity, current symbolic branch, and current HEAD; execute only fixed origin and one captured-commit refspec.
- Map non-fast-forward to GITHUB_PUSH_NON_FAST_FORWARD and possible post-launch/timeout/process uncertainty to GITHUB_PUSH_OUTCOME_UNCERTAIN.

- [ ] **Step 1: Write failing push tests**

Use temporary real repositories to assert that a same-name remote branch advances, a missing same-name branch is created, the captured OID is used instead of HEAD, and only origin plus one refspec is invoked. Add branch/commit drift, non-fast-forward, write-scope, askpass-only credential, lifecycle launch-fence, and project-push marker-binding tests.

- [ ] **Step 2: Run the focused Git tests and verify the expected failure**

~~~text
pnpm exec vitest run apps/agent/src/authenticated-git-failure.test.ts apps/agent/src/external-execution.test.ts apps/agent/src/managed-workspaces.github-app.test.ts
~~~

Expected: FAIL because push execution, the write authority callback, role, and non-fast-forward classification are absent.

- [ ] **Step 3: Implement the bounded push path**

Reuse protectedGitInvocation and withExactRepositoryWriteToken. Load and revalidate store/workspace ownership. Construct only (using the live authority-resolved HTTPS URL for managed origin):

~~~text
git [protected options] -C <owned-worktree> push -- <authority-resolved-origin-url> <captured-commit>:refs/heads/<captured-branch>
~~~

Acquire the existing lifecycle launch fence and recheck branch/HEAD while it is held. Treat timeout, signal, or an execution exception after possible launch as uncertainty. Keep public fetch/clone/inspect unchanged.

- [ ] **Step 4: Run the focused Git tests and verify green**

Confirm existing private read tests and new push success, new branch, drift, non-FF, scope, fence, marker, and credential tests pass.

- [ ] **Step 5: Commit**

~~~text
git add apps/agent/src/authenticated-git-failure.ts apps/agent/src/authenticated-git-failure.test.ts apps/agent/src/external-execution.ts apps/agent/src/external-execution.test.ts apps/agent/src/managed-workspaces.ts apps/agent/src/managed-workspaces.github-app.test.ts
git commit -m "feat: execute fenced explicit GitHub push"
~~~

### Task 4: Terminalize interrupted push journal records

**Files:**
- Modify: apps/agent/src/operation-journal.ts
- Modify: apps/agent/src/operation-journal.test.ts
- Modify: apps/agent/src/operation-executor.ts
- Modify: apps/agent/src/operation-executor.test.ts
- Modify: apps/agent/src/server.ts

**Interfaces:**
- Include project.push in supported mutation names.
- During OperationJournal.initialize(), durably rewrite accepted/running project.push records to failed GITHUB_PUSH_OUTCOME_UNCERTAIN, retaining the original strict request.
- Expose the terminal failure through F10 observations and never return that push from resumable().
- Dispatch project.push to ManagedWorkspaces.push and map its failure codes to endpoint statuses.

- [ ] **Step 1: Write failing journal/executor tests**

Accept and mark a strict push request running, initialize a second journal over the same directory, then assert resumable() is empty, the observation is terminal with GITHUB_PUSH_OUTCOME_UNCERTAIN, and the original repository/branch/commit request remains intact. Add an executor dispatch test preserving captured fields and a server mutation-route test.

- [ ] **Step 2: Run the focused journal/executor tests and verify the expected failure**

~~~text
pnpm exec vitest run apps/agent/src/operation-journal.test.ts apps/agent/src/operation-executor.test.ts apps/agent/src/server.test.ts
~~~

Expected: FAIL because the operation is unknown and current restart logic leaves it resumable.

- [ ] **Step 3: Implement durable terminalization and dispatch**

Add the mutation name, startup rewrite using the existing durable writer and timestamp, executor switch case, server mutation route, and error-status mapping. Preserve the request unchanged while changing state, timestamp, and failure. Make external marker validation recognize project-push.

- [ ] **Step 4: Run the focused journal/executor tests and verify green**

Confirm restart observations are terminal, no push is scheduled after restart, captured identity is preserved, and ordinary operation recovery remains unchanged.

- [ ] **Step 5: Commit**

~~~text
git add apps/agent/src/operation-journal.ts apps/agent/src/operation-journal.test.ts apps/agent/src/operation-executor.ts apps/agent/src/operation-executor.test.ts apps/agent/src/server.ts
git commit -m "feat: terminalize uncertain pushes on restart"
~~~

### Task 5: Add Web push preparation, confirmation, and uncertainty persistence

**Files:**
- Create: apps/web/src/server/project-push.ts
- Create: apps/web/src/server/project-push.test.ts
- Create: apps/web/src/app/api/projects/[projectId]/push/route.ts
- Create: apps/web/src/app/api/projects/[projectId]/push/route.test.ts
- Modify: apps/web/src/server/agent-client.ts
- Modify: apps/web/src/server/database.ts
- Modify: apps/web/src/server/failure-policy.ts

**Interfaces:**
- Add createAgentClient().pushProject(operationId, data), the only Web-to-Agent push submission method.
- Add typed database helpers for an operation whose bounded progressJson contains the captured source/generation/branch/commit/ahead/behind intent.
- Produce prepareProjectPush(projectId, actor, dependencies) and confirmProjectPush(projectId, operationId, actor, dependencies).

- [ ] **Step 1: Write failing Web orchestration tests**

Cover preparation from an actor-owned ready primary GitHub source, exact persisted identity/generation/branch/commit, confirm submission from the server-captured request only, branch/commit/source/generation drift rejection before Agent submission, Agent failure mapping, Agent-unavailable terminal uncertainty, and no second Agent call on repeated confirm. Assert public remote sources are not exposed as Push while existing fetch is unaffected.

- [ ] **Step 2: Run the focused Web tests and verify the expected failure**

~~~text
pnpm exec vitest run apps/web/src/server/project-push.test.ts apps/web/src/app/api/projects/[projectId]/push/route.test.ts
~~~

Expected: FAIL because the push module, client method, database helpers, and route do not exist.

- [ ] **Step 3: Implement Web persistence and orchestration**

Use operations with resourceType workspace, resourceId workspaceId, and a bounded validated progress document. Prepare calls getRuntimeContext, getProjectSourceLocator, agent.inspectGit, and getGithubAuthorityContext; it requires live branch equality and a non-null commit. Confirm reloads those values, requires unchanged admitted generation, persists submitted progress before calling Agent, polls observations, maps terminal failures, and marks any transport uncertainty as GITHUB_PUSH_OUTCOME_UNCERTAIN without resubmitting.

- [ ] **Step 4: Implement the route and client method**

Require authentication and CSRF. Parse only { action: prepare } or { action: confirm, operationId }; reject all other fields. Return prepared details or safe terminal messages and never accept browser branch, commit, URL, remote, refspec, or force fields.

- [ ] **Step 5: Run the focused Web tests and verify green**

Confirm identity, drift, lifecycle, no-retry, write-permission, non-FF, uncertainty, and public-regression tests pass.

- [ ] **Step 6: Commit**

~~~text
git add apps/web/src/server/project-push.ts apps/web/src/server/project-push.test.ts apps/web/src/app/api/projects/[projectId]/push apps/web/src/server/agent-client.ts apps/web/src/server/database.ts apps/web/src/server/failure-policy.ts
git commit -m "feat: add explicit push Web workflow"
~~~

### Task 6: Add the minimal temporary Workbench action and state documentation

**Files:**
- Modify: apps/web/src/server/project-workspace.ts
- Modify: apps/web/src/app/projects/[projectId]/page.tsx
- Modify: apps/web/src/app/project-workbench.tsx
- Modify: the existing Workbench test location, or create the smallest focused UI test file if none exists
- Modify: docs/current-state.md

**Interfaces:**
- Supply GitHub App source availability from retained database identity; never infer authority from a URL.
- Show Push only when available, display repository/branch/captured commit/ahead-behind relation, provide explicit Confirm/Cancel controls, and provide no automatic retry.

- [ ] **Step 1: Write failing UI tests**

Render a GitHub-backed project, click Push, assert the prepared repository/branch/commit is visible, confirm with only the returned operation ID, and verify success/uncertainty/non-FF notices. Assert public remote projects have no Push action.

- [ ] **Step 2: Run the focused UI test and verify the expected failure**

~~~text
pnpm exec vitest run apps/web/src/app/project-workbench.test.ts
~~~

Expected: FAIL because the Workbench has no Push state or controls.

- [ ] **Step 3: Implement the temporary top-bar confirmation surface**

Add local state beside Fetch. Prepare with only the prepare action, render returned values, and confirm with only the opaque operation ID. Refresh after success; keep uncertainty terminal and instruct the user to inspect/fetch and prepare a new push. Do not add branch or commit inputs.

- [ ] **Step 4: Update docs/current-state.md**

Replace stale CP3A-active/CP3B-deferred status with factual CP3B status, exact write scope, permission-loss reauthorization, terminal uncertainty, and remaining Workbench exclusions.

- [ ] **Step 5: Run the focused UI test and verify green**

Confirm the temporary UI behavior passes.

- [ ] **Step 6: Commit**

~~~text
git add apps/web/src/server/project-workspace.ts apps/web/src/app/projects/[projectId]/page.tsx apps/web/src/app/project-workbench.tsx docs/current-state.md
git commit -m "feat: expose explicit push in the workbench"
~~~

### Task 7: Run repository verification and self-review

**Files:** Modify only files required by verified failures.

- [ ] **Step 1: Run focused CP3B tests**

Run every focused contract, authority, managed Git, journal, executor, Web, route, and UI test changed above. Record exact pass counts and fix failures with the TDD red-green loop.

- [ ] **Step 2: Run the required repository gates**

Run each command separately:

~~~text
pnpm workspace:check
pnpm lint
pnpm test
pnpm typecheck
pnpm build
pnpm contracts:check
pnpm schema:check
pnpm db:migrate:test
pnpm db:check
~~~

Run pnpm install --frozen-lockfile if dependency state requires a clean verification install; no dependency is expected.

- [ ] **Step 3: Run security and diff checks**

Run the repository-pinned Semgrep command if one is provided, then:

~~~text
git diff --check origin/main...HEAD
git status --short
git diff --stat origin/main...HEAD
~~~

Review for arbitrary browser-controlled Git values, read-token scope changes, credential persistence, retry paths, public behavior changes, and accidental Workbench scope.

- [ ] **Step 4: Commit only verified final corrections**

Stage only the files changed by the verified correction, then commit them with message `fix: tighten CP3B push verification`.

- [ ] **Step 5: Final verification before handoff**

Rerun every failed gate and final diff/status commands after the last commit. Report baseline proof, implementation semantics, uncertainty/no-retry behavior, requested literal outputs, deferred scope, and all local commits. Do not push, open a PR, merge, or deploy.
