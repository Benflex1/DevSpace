# DevSpace Private GitHub Access CP3B — Explicit Push Design

**Status:** Approved for implementation

**Baseline:** `main` and `origin/main` are both `58a0368224f201f6f8d508538c84a4decca18a83`; the root tree is `00e501638b52407cb27f12a7704f94daf3d38bf5`. CP3A is already merged and owns the GitHub lifecycle generation/admission fence, exact repository identity, token lease, askpass, and authenticated Git boundaries.

## Goal

Add the smallest owner-only alpha workflow for a private GitHub App source:

```text
clone → edit → commit → fetch → explicit push
```

Push is a confirmed, same-branch, single-commit update with no persisted reusable credential and no automatic retry after an uncertain remote effect.

## Boundaries and authority

- The browser talks only to Web APIs. It sends only an action and an opaque push operation/intent ID; it never sends a repository URL, remote, refspec, branch, commit OID, or force option.
- Web remains the sole SQLite writer and derives every push value from the actor-owned project, primary managed workspace, current Agent inspection, and current GitHub connection state.
- The Agent remains the only component that invokes Git. Its push request is a server-built contract containing the captured source identity, branch, commit, and expected lifecycle generation.
- The source identity is always `{ connectionId, repositoryId }`; the GitHub repository URL is resolved by the existing CP3A authority path and is not a browser input.
- CP3B adds push only for a GitHub App-backed source. Existing public remote clone/fetch/inspect behavior is unchanged and no generic provider abstraction is introduced.

## User/API flow

### Prepare

`POST /api/projects/{projectId}/push` with the prepare action (or an empty action body) performs a read-only preparation:

1. Authenticate the actor and validate CSRF.
2. Require a ready primary managed workspace and an actor-owned GitHub App source.
3. Ask the Agent for `project.git.inspect` on that workspace.
4. Require a non-detached branch, a non-null local commit, and equality between the live branch and the Web-recorded workspace branch.
5. Read the current admitted GitHub lifecycle generation.
6. Persist the captured intent in the existing Web `operations.progressJson`, keyed by the generated operation ID. The captured fields are the project/workspace, connection ID, repository ID, lifecycle generation, branch, commit, and available ahead/behind relation.

The prepare response contains the operation ID and display-safe captured details. It does not authorize a remote write.

### Confirm

`POST /api/projects/{projectId}/push` with only the opaque operation ID confirms the prepared intent. Web loads the durable operation and actor ownership, then re-inspects the workspace and re-reads the source/lifecycle context. It rejects the intent if any of the following changed:

- project/workspace/source ownership;
- `connectionId` or `repositoryId`;
- lifecycle generation or admission;
- the recorded workspace branch;
- the live symbolic branch;
- the live `HEAD` commit.

Only after those checks does Web submit the Agent `project.push` mutation using the captured values. A prepared, submitted, succeeded, failed, or uncertain operation cannot be silently reused for a second remote write; another attempt starts with a new prepare.

## Agent push semantics

The new `project.push` mutation request is strict and contains:

```text
projectId
workspaceId
source: { kind: "github-app", connectionId, repositoryId }
branchName
commitOid
githubAuthorityGeneration
```

Before Git launch, the Agent:

1. Validates the managed workspace and exact store ownership.
2. Confirms the stored source identity is exactly the request source.
3. Confirms the current symbolic branch and `rev-parse HEAD` exactly equal the captured branch and commit.
4. Requests a fresh exact-repository GitHub App installation token with exactly:

   ```json
   {"repository_ids":[EXACT_REPOSITORY_ID],"permissions":{"contents":"write"}}
   ```

5. Requires the live binding and returned token scope to contain exact selected-repository `contents: write` authority. A binding without write permission fails with the existing CP3A permission/reauthorization path; it never falls back to a read token or broadens scope.
6. Performs the existing final lifecycle admission check and launch fence immediately before authenticated Git spawn.
7. Rechecks branch and commit while the launch fence is held.
8. Invokes Git with the existing positive protected environment and askpass transport, fixed remote `origin`, and exactly one refspec:

   ```text
   <captured-commit>:refs/heads/<captured-branch>
   ```

No implicit `HEAD`, force flag, tag, deletion, push option, upstream mutation, submodule credential, hook, SSH, inherited Git config, or alternate remote is permitted.

The existing read token methods remain byte-for-byte read-scoped in behavior: list/resolve/inspect/clone/fetch continue requesting only their current metadata-read or exact-repository contents-read permissions.

## Lifecycle, failures, and uncertainty

- Disconnected or stale generation is rejected before token mint.
- A generation change during proof/mint settles or revokes the token through the existing lease model and prevents Git launch.
- A generation change immediately before launch fails the launch fence and prevents Git launch.
- An already-launched Git process may settle; reconnect never resumes an old push.
- `GITHUB_PUSH_NON_FAST_FORWARD` is a terminal, useful failure. It directs the user to fetch, integrate with Git/terminal, and explicitly prepare/Push again. It is never retried automatically.
- Timeout, signal, process-management loss after a possible launch, lost Agent response, or Agent restart while a push is nonterminal produces terminal `GITHUB_PUSH_OUTCOME_UNCERTAIN`. This means the remote effect is unknown, not that GitHub rejected the push.
- Existing Agent journal records for `project.push` in `accepted` or `running` are converted durably to failed `GITHUB_PUSH_OUTCOME_UNCERTAIN` during journal initialization. They are not merely excluded from resume, so F10 exposes a terminal observation and startup cannot retry them.
- The captured operation request remains in the Agent journal and the Web operation progress so reconciliation can display the intended repository/branch/commit. No automatic resend is performed. A later explicit action must begin with a new preparation; CP3B does not build a general remote-effect framework.
- Successful push may create the same-name remote branch or advance it. Non-fast-forward, force, tags, deletion, multiple refspecs, arbitrary branch destinations, and PR workflows are out of scope.

## Temporary Web UX

For GitHub App-backed projects, the existing Workbench top bar gets a `Push` action beside Fetch. The action opens a small confirmation surface showing repository, branch, captured local commit, and the available `origin/{branch}` ahead/behind relation. Confirm submits only the operation ID. The UI displays success, non-fast-forward guidance, permission/reauthorization guidance, stale-intent guidance, or uncertainty without offering an automatic retry.

No Files, Editor, Changes Workbench, branch-management, merge/rebase, or conflict-resolver UI is added.

## Persistence

No SQLite table is added. The existing Web `operations` row and its bounded `progressJson` carry the prepared/submitted/uncertain intent for the temporary workflow. The existing Agent operation journal is extended with the new mutation and startup terminalization rule. This is sufficient to block automatic/restart resend while preserving the captured intent.

## Verification scope

Focused tests cover:

- exact write token body/scope and exact repository ID;
- unchanged read-only token bodies;
- missing write permission through the CP3A permission path;
- fixed origin, same-branch-only destination, captured commit rather than mutable `HEAD`;
- branch/commit drift before confirmation and immediately before launch;
- disconnected/stale lifecycle and token-returned-after-fence rejection;
- useful non-fast-forward mapping;
- successful existing-branch advancement and new same-name branch creation;
- terminal uncertain outcomes, no resend, and no restart retry;
- askpass-only in-memory credentials and unchanged public Git behavior.

Repository-wide workspace, lint, test, typecheck, build, contract, schema, migration, database, diff, and security gates remain required before the implementation is considered complete.

## Explicit exclusions

Force push, force-with-lease, tags, deletion, arbitrary refspecs/remotes/branches, branch switching/creation UI, merge/rebase/conflict UI, PR/Issues, PAT/OAuth, GitHub Enterprise, generic provider abstraction, webhooks, multiple identities, submodule credentials, push options, hook execution, and automatic deployment are not part of CP3B.
