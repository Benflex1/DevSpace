# M1 Slice 5 — Preview Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated developer open a configured workspace preview through a deterministic DevSpace hostname after manually starting the application inside the running workspace.

**Architecture:** The Agent owns preview target validation, exact runtime identity, loopback-only Docker port bindings, bounded health checks, and Caddy route reconciliation. Caddy is a dedicated gateway with a private admin endpoint and receives only `127.0.0.1:<Agent-managed-lease>` upstreams; it never receives a Docker socket or arbitrary upstream. Web remains the sole SQLite writer and maps detailed Agent lifecycle observations to the user-facing `Inactive`, `Waiting`, `Ready`, and `Unavailable` states.

**Tech Stack:** TypeScript/Node 24, Zod contracts, Drizzle + SQLite migrations, the existing dedicated rootless Docker Engine API adapter, Caddy Admin API, Next.js/React Workbench, WebSocket-compatible HTTP reverse proxying, and Playwright with the existing deterministic Docker/HTTPS E2E supervisor.

---

## Current-repository findings and decisions

The current `main` snapshot already contains the Project Options preview schema and cross-reference checks, deterministic approved-base hostname composition in `@devspace/security`, detailed preview lifecycle guards in `@devspace/domain`, F09/F10 preview contract shapes and endpoint descriptors, an initial `previews`/`port_leases` database shape, and the accepted Caddy ADRs. It does not contain the implementation: `packages/gateway-caddy` is still deferred, Agent preview routes are not dispatched, `WorkspaceRuntimeManager` creates containers with no port bindings, Web has no preview orchestration, and the current page predates the Workbench/tab implementation.

The approved design maps onto the detailed lifecycle as follows:

| User state | Authoritative condition |
| --- | --- |
| Inactive | preview is not configured for this workspace revision, or the runtime is stopped/absent and no route exists |
| Waiting | preview is configured and desired active, the exact workspace runtime is running, but the declared app port has not passed the bounded health check |
| Ready | health check passed and the exact hostname route is present |
| Unavailable | runtime/ownership/gateway/health operation failed, was lost, or the configured target is an unsupported service target |

`starting`, `healthy`, `unhealthy`, `stopping`, `failed`, and `lost` remain the domain and Agent states. The Web UI must not replace them in SQLite with a second lifecycle authority.

### Recommended networking topology

Use Agent-managed loopback-only Docker port bindings and leases:

1. At exact workspace runtime creation, the Agent reads the registered Project Options revision and derives one opaque loopback lease per configured preview target. The container receives only bindings whose `HostIp` is `127.0.0.1`, whose container port appears in the active revision, and whose host port is owned by the exact workspace/runtime generation.
2. The workspace container still has no public port and no Docker socket. The Agent stores the lease and binding identity in Agent-private state bound to project, workspace, revision, generation, container ID, preview ID, and container port.
3. Caddy routes the exact approved hostname to the corresponding loopback lease. Caddy is not attached to workspace networks and cannot inspect or reach arbitrary container networks. Its admin endpoint is bound to a private Unix socket or loopback listener inaccessible through the public listener.

This is safer and simpler for M1 than gateway attachment to every workspace network: it preserves network isolation even if a route is misconfigured, avoids giving Caddy a Docker-facing data-plane position, uses the loopback-binding allowance already represented by `port_leases`, and lets the Agent perform health checks without a probe container. A network-attached gateway would create a broad cross-workspace blast radius; an Agent-written HTTP reverse proxy would conflict with the accepted Caddy decision. The loopback lease is a controlled internal binding, not arbitrary public host-port publication.

The production gateway is a dedicated host Caddy service, not a workspace container: `*.benflex.dev → Cloudflare Tunnel → Caddy → exact loopback lease`. Local E2E uses the same gateway/data-plane path with an approved `localhost` base and no Cloudflare.

### Contract decision

The existing `preview.activate`, `preview.deactivate`, and `preview.inspect` wire shapes are sufficient and must be completed rather than accepting browser-supplied ports, hostnames, upstreams, Docker IDs, or Caddy fragments. Mutation operation identity remains the existing `X-DevSpace-Operation-Id` plus Agent journal. Internal diagnostic stage/cause and operation identity are persisted by Web and Agent-private records; they are not exposed as open browser metadata. No new browser-supplied preview fields or open diagnostic metadata are added in this slice. The internal gateway adapter contract is a new package API, not a browser API. The Web and Agent runtime configuration each receive the same administrator-approved preview-base registry so both sides derive the same hostname from the immutable revision.

## Checkpoint 1: Materialize preview identity, revision policy, and persistence

**Capability:** A configured preview becomes a durable, exact workspace-scoped resource whose hostname and runtime policy can be reconciled without inventing service execution support.

**Files:**

- Modify: `packages/database/src/schema.ts` — make the existing preview row represent both workspace and service targets; make `hostname` nullable until a route is ready; add display name, target kind/key, domain-base ID, hostname pattern, health statuses JSON, startup timeout, WebSocket flag, runtime generation, last observation/error fields, and operation identity; retain loopback-only `port_leases` with explicit preview/runtime-generation ownership.
- Create: `packages/database/src/migrations/0002_preview_path.sql` and generated metadata under `packages/database/src/migrations/meta/` — rebuild the SQLite preview tables safely, preserve existing rows, and add checks/indexes for UUIDs, approved target kinds, 1–65535 ports, loopback addresses, bounded JSON, and route/hostname consistency.
- Modify: `packages/database/src/schema.test.ts`, `packages/database/src/migration.test.ts` — cover migration from `0001`, workspace-target rows with no service ID, service-target rows retained as valid configuration, nullable hostname while waiting, loopback lease uniqueness, and foreign-key cleanup.
- Create: `apps/web/src/server/preview-persistence.ts` — define the Web-owned materialization/read/update functions. Materialize only the active immutable Project Options revision; derive the hostname with `composePreviewHostname` and the administrator-approved base registry; never accept a browser hostname, port, upstream, or target identity.
- Modify: `apps/web/src/server/database.ts` — expose preview views beside the managed project view, persist route/observation/error updates transactionally, bind operation rows to `{ projectId, workspaceId, previewId }`, and reject a stale revision or workspace identity.
- Modify: `apps/web/src/server/config.ts` — parse a closed administrator-owned preview-base registry from deployment configuration and reject malformed/duplicate IDs or domains before the Web starts.
- Modify: `packages/project-options/src/runtime-plan.test.ts`, `packages/security/src/preview-hostnames.test.ts` — add fixtures proving the active revision’s declared workspace port is the only executable preview port and hostname composition is deterministic for the same project/workspace/preview/short ID.

- [ ] **Step 1: Write the failing persistence and migration tests.** Assert that a workspace target can be inserted without `service_id` or `hostname`, that a service target remains representable, that route-ready rows require hostname, and that two live leases cannot claim the same loopback address/port.
- [ ] **Step 2: Run the focused tests and verify they fail.**

  Run: `pnpm --filter @devspace/database test -- --run packages/database/src/migration.test.ts packages/database/src/schema.test.ts`

  Expected: failures identify the missing migration/schema fields and preview persistence behavior.

- [ ] **Step 3: Implement the schema migration and Web persistence boundary.** Keep the immutable Project Options JSON as the source of configuration truth. Store only a materialized revision identity and bounded observations in preview rows. Map a service target to a durable `unsupported-runtime-policy` diagnostic path; do not silently convert it to a workspace target.
- [ ] **Step 4: Run focused verification.**

  Run: `pnpm --filter @devspace/database run db:check`

  Expected: migration check passes and the focused database tests pass.

- [ ] **Step 5: Commit and push the checkpoint.**

  ```bash
  git add packages/database packages/project-options/src/runtime-plan.test.ts packages/security/src/preview-hostnames.test.ts apps/web/src/server/database.ts apps/web/src/server/preview-persistence.ts
  git commit -m "feat: persist workspace preview state"
  git push origin feat/milestone-1-preview-path
  ```

**Acceptance criteria:** A database-only test can create two projects with equal preview keys and deterministic but distinct hostnames, can represent a waiting preview with no route/hostname, and can prove that a service-targeted option remains valid configuration but is not executable as a workspace preview.

## Checkpoint 2: Add Agent-owned loopback exposure, health checks, and lifecycle reconciliation

**Capability:** The Agent can safely expose only a declared workspace port, classify an app that has not started as `Waiting`, and make the route target unusable when the exact runtime is stopped, lost, replaced, or drifted.

**Files:**

- Modify: `apps/agent/src/docker-runtime.ts` — support a strict `PortBindings` input and inspect the published binding; accept only loopback host IPs, exact declared container ports, and validated numeric host ports; keep `PublishAllPorts: false` and reject every public/host-network binding.
- Modify: `apps/agent/src/workspace-runtime.ts` — derive and durably reserve preview leases before the first Docker side effect, include exact preview binding records in runtime ownership/creation evidence, recreate only operation-owned leases, and validate bindings during start/stop/restart inspection.
- Create: `apps/agent/src/preview-runtime.ts` — load the exact registered Project Options revision, reject service targets with `RUNTIME_POLICY_VIOLATION` and a clear `unsupported-runtime-policy` cause, validate workspace target ports against the runtime plan, allocate bounded deterministic loopback leases, and perform bounded HTTP health checks with abortable requests, accepted statuses, health path, backoff, and `startupTimeoutSeconds`.
- Create: `apps/agent/src/preview-runtime.test.ts` — test waiting-before-app-start, accepted/rejected status codes, timeout bounds, retry backoff, WebSocket-compatible route target metadata, unsupported service targets, runtime-generation mismatch, and stale lease removal.
- Modify: `apps/agent/src/managed-workspaces.ts`, `apps/agent/src/operation-executor.ts`, `apps/agent/src/private-state.ts`, `apps/agent/src/server.ts`, `apps/agent/src/cli.ts` — initialize/validate preview private-state directories, parse the same administrator-approved preview-base registry, bind preview activation/deactivation to the exact workspace ownership record and operation journal, include preview observations in snapshots, and preserve stage/cause/operation ID for diagnostics without leaking secrets or arbitrary paths.
- Modify: `apps/agent/src/server.ts` — dispatch the already-defined `preview.activate`, `preview.deactivate`, and `preview.inspect` routes, use the existing strict endpoint/error schemas, and make replay idempotent for the same operation ID/request.
- Modify: `apps/agent/src/index.test.ts`, `apps/agent/src/server.security.test.ts`, `apps/agent/src/workspace-runtime.test.ts`, `apps/agent/src/docker-runtime.test.ts` — cover request identity, route dispatch, loopback-only Docker payloads, runtime loss, and restart recovery.

- [ ] **Step 1: Write failing Agent tests for the policy boundary and health state machine.** Use the existing Docker Engine fixture to assert no `HostIp` other than loopback is accepted, no undeclared port is bound, and an exact running container with no listener remains `starting`/`unhealthy` rather than `failed` until the configured deadline.
- [ ] **Step 2: Run the tests and verify the current Agent has no preview dispatch or binding support.**

  Run: `pnpm --filter @devspace/agent test -- --run apps/agent/src/preview-runtime.test.ts apps/agent/src/docker-runtime.test.ts apps/agent/src/server.security.test.ts`

  Expected: failures identify missing preview manager, route dispatch, and strict port-binding assertions.

- [ ] **Step 3: Implement the smallest exact Agent preview manager.** Keep health ownership in the Agent; do not add a browser polling loop or a general process supervisor. Route eligibility is `workspace runtime running` plus `health passed` plus `exact lease/revision/generation ownership`. Stop/loss/identity mismatch clears route eligibility immediately and records a bounded failure cause.
- [ ] **Step 4: Run focused Agent and contract verification.**

  Run: `pnpm --filter @devspace/agent test -- --run apps/agent/src/preview-runtime.test.ts apps/agent/src/docker-runtime.test.ts apps/agent/src/server.security.test.ts`

  Expected: PASS, including assertions that the container request contains no public host publication or Docker socket.

- [ ] **Step 5: Commit and push the checkpoint.**

  ```bash
  git add apps/agent/src apps/agent/test packages/contracts/src
  git commit -m "feat: manage preview health and loopback targets"
  git push origin feat/milestone-1-preview-path
  ```

**Acceptance criteria:** A real or fixture workspace can start an app manually from its terminal, transition from `Waiting` to healthy, and remain unreachable through the preview target after the exact container is stopped or ownership inspection fails. A service-targeted preview returns a typed, clear unsupported-runtime-policy result before any Docker or gateway side effect.

## Checkpoint 3: Implement the narrow Caddy gateway and route lifecycle

**Capability:** A healthy exact loopback target is available through one deterministic hostname with HTTP, WebSocket, and HMR forwarding, while stale or foreign routes are removed.

**Files:**

- Create: `packages/gateway-caddy/package.json`, `packages/gateway-caddy/tsconfig.json`, `packages/gateway-caddy/tsconfig.build.json`, `packages/gateway-caddy/src/index.ts`, `packages/gateway-caddy/src/routes.ts`, `packages/gateway-caddy/src/client.ts`, and colocated tests — promote the deferred directory into a library package and update its narrow workspace-graph entry in `tooling/workspace-graph.mjs`.
- Create: `packages/gateway-caddy/src/types.ts` — define closed route inputs containing only approved hostname, loopback lease, route revision, preview/workspace identity, and WebSocket policy; define typed stage/cause errors and route inspection results.
- Create: `packages/gateway-caddy/src/client.ts` — use the private Caddy Admin API or Unix-socket adapter with bounded requests, exact route replacement, route inspection, and removal. Never accept raw Caddy JSON from Web or the browser.
- Modify: `apps/agent/src/preview-runtime.ts`, `apps/agent/src/operation-executor.ts`, `apps/agent/src/server.ts` — apply a route only after health passes, remove it before/while stopping, reconcile Caddy routes against current exact Agent-owned preview records after restart, and mark route presence/hostname truthfully.
- Create: `tooling/preview-gateway-fixture.mjs` and `tooling/tests/preview-gateway-fixture.test.mjs` — provide a deterministic local gateway/data-plane fixture with host-based route matching, HTTP streaming, WebSocket upgrade forwarding, and exact-route rejection. It is test infrastructure only; the production adapter remains Caddy-specific.
- Modify: `apps/agent/package.json`, `tooling/check-workspace-graph.mjs`, `pnpm-lock.yaml`, `packages/gateway-caddy/README.md` — make the Agent depend on the adapter and make the package graph/deferred-package checks reflect the now-active adapter.

- [ ] **Step 1: Write failing adapter tests.** Test exact host matching, loopback-only upstream validation, route replacement by `(projectId, workspaceId, previewId, revision, generation)`, WebSocket upgrade preservation, removal of stale routes, rejection of foreign workspace identity, and bounded admin failure reporting.
- [ ] **Step 2: Run the gateway tests and verify they fail.**

  Run: `pnpm exec vitest run packages/gateway-caddy/src tooling/tests/preview-gateway-fixture.test.mjs`

  Expected: failures identify the missing package and route adapter.

- [ ] **Step 3: Implement the adapter and Agent reconciliation.** Generate routes from typed Agent-owned records. Configure Caddy’s reverse proxy for normal HTTP streaming and WebSocket/HMR upgrade forwarding; do not force iframe headers or rewrite application security headers. The route set is replaced atomically from the exact desired set, so a route absent from current ownership is deleted.
- [ ] **Step 4: Run focused package, boundary, and contract checks.**

  Run: `pnpm workspace:check`

  Expected: the new library is recognized, the deferred directory is no longer rejected, and route tests pass.

- [ ] **Step 5: Commit and push the checkpoint.**

  ```bash
  git add packages/gateway-caddy tooling/preview-gateway-fixture.mjs tooling/tests/preview-gateway-fixture.test.mjs tooling/workspace-graph.mjs tooling/check-workspace-graph.mjs pnpm-lock.yaml apps/agent/src
  git commit -m "feat: reconcile caddy preview routes"
  git push origin feat/milestone-1-preview-path
  ```

**Acceptance criteria:** A fixture route serves an HTTP app and preserves a WebSocket/HMR upgrade only for its exact approved hostname; a stopped or lost runtime causes route removal; Caddy has no Docker socket, no public admin endpoint, and no route whose upstream was supplied by the browser.

## Checkpoint 4: Orchestrate previews in Web and integrate the Workbench

**Capability:** The Web application reconciles configured previews after runtime changes and the Workbench shows a real `PREVIEWS` section with stable deduplicated `preview:<previewId>` tabs.

**Files:**

- Create: `apps/web/src/server/preview-orchestration.ts` and modify `apps/web/src/server/workspace-runtime.ts` — add desired-state orchestration around the existing runtime operation flow. On a running exact workspace, activate each workspace-targeted configured preview; on stop/loss, deactivate and reconcile every route; preserve accepted/running/terminal operation identity and internal stage/cause.
- Modify: `apps/web/src/server/agent-client.ts` — add typed `activatePreview`, `deactivatePreview`, and `inspectPreview` methods using the existing endpoint registry; map Agent errors without replacing typed causes with a generic success/failure boolean.
- Create: `apps/web/src/app/api/projects/[projectId]/previews/route.ts` — authenticated, CSRF-protected GET for the Web-owned preview view and POST only for bounded UI actions (`reload`/reconcile if needed); browser input contains IDs/actions only.
- Modify: `apps/web/src/server/database.ts`, `apps/web/src/server/project-workspace.ts` — include preview definitions/statuses and relevant route/error observations in the page data, with exact project/workspace/revision authorization.
- Create or modify: `apps/web/src/app/project-workbench.tsx`, `apps/web/src/app/workbench-tabs.ts`, `apps/web/src/app/preview-tab.tsx`, `apps/web/src/app/preview-lifecycle.ts`, and `apps/web/src/app/preview-lifecycle.test.ts` — add a real Previews sidebar section, map detailed states to `Ready`/`Waiting`/`Unavailable`/`Inactive`, implement `preview:<previewId>` identity and deduplication, embed only when ready, and provide Reload/Open Externally plus useful unavailable/waiting text.
- Modify: `apps/web/src/app/projects/[projectId]/page.tsx`, `apps/web/src/app/styles.css`, and the existing Workbench tests — render the Workbench for ready projects and preserve current terminal behavior. If the accepted Workbench predecessor is not yet on `main`, port its existing terminal/tab files from `feat/milestone-1-project-workbench` unchanged before adding preview behavior; do not redesign tab identity.

- [ ] **Step 1: Write failing Web tests.** Cover preview view authorization, activation operation reuse, route/hostname truthfulness, user-state mapping, stable tab deduplication, close/fallback behavior, Reload, Open Externally, iframe readiness gating, and the rule that application response headers are not rewritten by DevSpace.
- [ ] **Step 2: Run focused Web tests and verify they fail.**

  Run: `pnpm --filter @devspace/web test -- --run apps/web/src/server/preview-orchestration.test.ts apps/web/src/app/preview-lifecycle.test.ts apps/web/src/app/workbench-tabs.test.ts`

  Expected: failures identify absent preview orchestration, API data, and tab/surface behavior.

- [ ] **Step 3: Implement Web orchestration and UI.** Use bounded server-side observation after actions and visibility-aware refresh only while a preview is `starting`/`unhealthy`/operation-active; do not create permanent aggressive polling. The iframe receives the derived hostname URL only after `routePresent=true`; external opening uses the same URL and a normal browser navigation.
- [ ] **Step 4: Run focused verification.**

  Run: `pnpm --filter @devspace/web test -- --run apps/web/src/server/preview-orchestration.test.ts apps/web/src/app/preview-lifecycle.test.ts apps/web/src/app/workbench-tabs.test.ts`

  Expected: PASS, including service-targeted configuration showing `Unavailable — unsupported runtime policy` rather than appearing as a runnable workspace preview.

- [ ] **Step 5: Commit and push the checkpoint.**

  ```bash
  git add apps/web/src/server apps/web/src/app
  git commit -m "feat: add previews to the project workbench"
  git push origin feat/milestone-1-preview-path
  ```

**Acceptance criteria:** The sidebar renders entries such as `● Web Ready` and `○ API Waiting`; clicking the same preview repeatedly activates one `preview:<previewId>` tab; waiting/unavailable states are usable and truthful; Reload requests a bounded reconciliation; Open Externally does not bypass the derived hostname; and iframe embedding does not attempt to override `X-Frame-Options` or CSP.

## Checkpoint 5: Permanent local E2E, restart/reconciliation hardening, review, and PR preparation

**Capability:** The full browser-to-gateway-to-exact-workspace path is deterministic locally and survives Web, Agent, gateway, and runtime state changes without stale routes or false readiness.

**Files:**

- Modify: `tooling/run-e2e-server.mjs` — start the local preview gateway fixture on a dedicated loopback listener, register an approved `localhost` preview base, expose controlled test hooks for app listener start/stop and Web/Agent/gateway restart, and keep Cloudflare/public internet out of the test.
- Modify: `tooling/docker-engine-fixture.mjs` — persist/inspect loopback port bindings, simulate an app listener becoming healthy, support WebSocket forwarding, and simulate exact container/runtime loss and binding drift.
- Modify: `tooling/seed-e2e-project.ts`, `e2e/primary-workspace.spec.ts` or create `e2e/preview-path.spec.ts` — seed a workspace-targeted preview and declared port, run `pnpm dev` through the existing terminal/exec path, drive the browser through `http://<deterministic-preview-host>.localhost:<gateway-port>`, and assert HTTP, WebSocket/HMR, Waiting→Ready, Reload, external open, stop/loss unavailability, and route recreation after restart.
- Modify: `apps/web/src/server/preview-orchestration.test.ts`, `apps/agent/src/preview-runtime.test.ts`, `packages/domain/src/experience-lifecycles.test.ts`, and gateway tests — cover every approved failure stage/cause and operation identity without broad logging changes.
- Modify: `docs/current-state.md` — record the implemented preview path, local gateway strategy, and any explicitly deferred service/Cloudflare/sharing behavior at the milestone checkpoint.

- [ ] **Step 1: Add deterministic fixture behavior and failing browser assertions.** Assert the browser request sequence is `browser → preview hostname/gateway → exact workspace target`; assert the preview target never becomes a public host port and that an unrelated workspace/container cannot answer the route.
- [ ] **Step 2: Run the focused E2E test and verify the new assertions fail before implementation is complete.**

  Run: `pnpm exec playwright test e2e/preview-path.spec.ts --project=chromium`

  Expected: the preview path fails until the gateway, orchestration, and UI checkpoints are present.

- [ ] **Step 3: Implement restart/reconciliation evidence and finish the permanent E2E.** Reconcile from fresh Agent snapshot/route inspection after Web or Agent restart; treat an unknown accepted operation as in progress; remove routes for missing runtime ownership; recreate only exact revision/generation routes; and keep health checks bounded by configured startup timeout.
- [ ] **Step 4: Run focused and full verification.**

  Run:

  ```bash
  pnpm exec playwright test e2e/preview-path.spec.ts --project=chromium
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

  Expected: every command exits zero; the E2E proves HTTP/WebSocket forwarding, manual app start, restart, stop/loss, exact workspace routing, and no permanent browser polling while idle.

- [ ] **Step 5: Perform the focused independent review.** Have a fresh reviewer inspect the diff and tests specifically for host isolation, cross-workspace routing, loopback/public binding mistakes, stale-route removal, revision/generation fencing, browser authorization, iframe header behavior, and operation recovery. Correct every finding and rerun the affected focused test.
- [ ] **Step 6: Prepare the PR and push the checkpoint.** Confirm the plan’s deferred items remain deferred: service-targeted execution, automatic dev-server startup, long-running supervision, per-preview Cloudflare API changes, preview sharing/public controls, and general logging overhaul. Update the PR description with topology, lifecycle mapping, local E2E proof, and residual trusted-repository risks.

  ```bash
  git add apps/agent apps/web packages/domain packages/gateway-caddy tooling e2e docs/current-state.md
  git commit -m "test: harden preview path recovery"
  git push origin feat/milestone-1-preview-path
  ```

**Acceptance criteria:** The permanent E2E opens the deterministic hostname through the gateway, reaches only the declared port in the exact workspace, preserves WebSocket/HMR, shows Waiting before manual app startup and Ready afterward, becomes unavailable truthfully on stop/loss, and recreates the route after restart without Cloudflare.

## Explicit security boundaries and failure modes

- Browser requests contain only authenticated project/workspace/preview IDs and bounded actions. Web authorizes every tuple against SQLite and is the sole SQLite writer.
- Agent derives target container, workspace generation, declared port, loopback lease, hostname, and Caddy route. It rejects arbitrary upstreams, public host IPs, host networking, Docker IDs from Web, cross-workspace identities, stale revisions, and service-target execution.
- Caddy receives no Docker socket, no public admin exposure, and no route outside the Agent-owned exact route set. A route is removed on runtime stop/loss, lease loss, ownership drift, gateway reconciliation, or Agent restart when identity cannot be proven.
- Health checks run in the Agent with an abort signal, configured path/statuses/timeout, bounded exponential backoff, and no browser-controlled interval. A developer who has not started the app is Waiting; timeout or gateway failure is Unavailable with retained stage/cause and operation identity.
- Preview JavaScript is a separate origin from the control plane. The preview tab does not forward control-plane cookies or rewrite application CSP/frame headers. A blocked iframe is shown as an application-controlled embedding limitation with Open Externally available.

## Design conflicts to resolve during implementation

1. `main` currently predates the Workbench/tab implementation, while the approved product design assumes it. Checkpoint 4 therefore has an explicit compatibility step to bring forward the existing accepted Workbench baseline without changing its stable tab model.
2. The initial `previews` table requires `service_id` and `hostname`, which conflicts with workspace-targeted previews and the required Waiting/no-route state. Checkpoint 1 must migrate those fields; this is a schema correction, not a new product concept.
3. The existing runtime creates no host bindings, while the security architecture already permits loopback-only preview bindings. Checkpoint 2 must add only Agent-derived loopback bindings and must retain the prohibition on arbitrary public host-port publication.
4. Existing F09 preview contracts use detailed `inactive/starting/healthy/unhealthy/stopping/failed/lost` states, while the UI asks for four simpler labels. The plan keeps the accepted wire/domain states and adds a Web presentation mapping; it does not create a second persisted lifecycle.
5. Existing service-targeted Project Options are valid, but current M1 runtime-plan execution has no supporting-service runtime. Activation therefore returns the existing typed runtime-policy violation with an explicit unsupported-runtime-policy cause and never partially creates a route.
