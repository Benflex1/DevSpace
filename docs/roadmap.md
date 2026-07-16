# Roadmap

## Milestone 0 — Architecture and contracts

Deliver documentation, schemas, ADRs, contract fixtures, repository scaffold, and CI contract checks. No feature implementation.

After Milestone 0, this horizontal milestone sequencing will be replaced by a vertical product
roadmap. The first post-M0 milestone must produce a genuinely usable primary-workspace path.

## Milestone 1 — Project onboarding and primary workspace foundation

Small independently testable slices:

1. **Global settings model**
   - managed project/worktree roots;
   - import roots;
   - approved preview-domain bases;
   - rootless runtime availability metadata.

2. **Project Options revision storage**
   - create draft;
   - strict validation;
   - activate and supersede transactionally;
   - retrieve active revision;
   - no Docker side effects.

3. **Agent health over Unix socket**
   - protocol negotiation;
   - capability report;
   - rootless runtime and managed-root checks;
   - no mutation.

4. **Repository source inspection**
   - inspect approved local import source or remote metadata;
   - detect Git repository/default branch;
   - collect package/runtime hints;
   - reject source paths outside configured import roots.

5. **Project registration**
   - persist project;
   - create draft detected options;
   - dashboard shows `configuration required`;
   - no managed clone yet.

6. **Activate Project Options**
   - compile canonical runtime plan;
   - agent policy validation;
   - store hashes and activate revision;
   - reject privileged/mount/socket policy violations.

7. **Managed repository store**
   - clone/import to agent-derived bare repository store;
   - verify ownership and remote;
   - idempotent retry and cleanup on failure.

8. **Primary worktree creation**
   - create default-branch worktree at agent-derived path;
   - persist primary workspace pinned to active revision;
   - verify branch, HEAD, and clean status.

9. **Stopped runtime-stack record**
   - create runtime stack desired/observed as absent or stopped;
   - no container creation yet;
   - show planned image/services/previews from the pinned revision.

10. **Project dashboard vertical slice**
    - project name/source/default branch;
    - active revision;
    - primary workspace branch and dirty state;
    - runtime not started state;
    - refresh through semantic agent inspection.

11. **Security and integration tests**
    - path/import-root escapes;
    - symlink source escape;
    - invalid refs;
    - duplicate primary workspace;
    - revision activation race;
    - idempotent managed-store/worktree operations;
    - browser cannot provide destination paths.

### Milestone 1 definition of done

- A trusted repository can be registered.
- Detected Project Options are reviewed and activated through the UI.
- DevSpace creates a managed repository store and primary Git worktree.
- The project dashboard shows correct Git and configuration state.
- No project command or container has run.
- Invalid paths and runtime-policy violations are rejected.
- Clean-clone lint, test, typecheck, build, schema, contract, and migration checks pass.

## Milestone 2 — Workspace runtime lifecycle

Implement the dedicated rootless Docker adapter, workspace stack creation, image pull/build, supporting services, start/stop/rebuild, resource limits, and reconciliation.

## Milestone 3 — Tasks and logs

Implement predefined structured commands, process supervision, stop/restart, exit status, rotated logs, and check summaries.

## Milestone 4 — Terminals

Implement xterm.js, container PTYs, resize, reconnect while the agent remains alive, multiple tabs, and explicit auditing.

## Milestone 5 — Previews

Implement Caddy routes, approved wildcard domains, health checks, HMR/WebSockets, route cleanup, and Cloudflare Access deployment validation.

## Milestone 6 — Optional isolated workspaces

Implement additional branch/worktree creation, independent stacks, dirty-state handling, archive/remove, and parallel previews.

## Milestone 7 — AI PTY sessions

Implement approved AI CLI profiles, credential injection, start/resume/interrupt/stop, and workspace-scoped session metadata.

## Milestone 8 — Git review and publishing

Implement diffs, staging, checks, explicit commits, pushes, and optional draft pull requests. Never auto-merge.

## Milestone 9 — Reliability and polish

Implement deeper reconciliation, stale cleanup, resource reporting, notification, metadata backup, and restore validation.
