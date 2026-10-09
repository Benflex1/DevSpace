# Current State

## Native harness slice

The generic native AI harness is implemented on `feat/generic-native-ai-harness`. The Workbench
defaults to Native; structured Codex app-server remains available as the secondary Legacy
presentation. Both use separate session lifecycles.

Live native Codex acceptance is complete. The authenticated Codex 0.159.0 TUI used a dedicated
private `CODEX_HOME` and made exactly one real model request, receiving
`DEVSPACE_NATIVE_HARNESS_OK`. Codex's canonical thread identity came from rollout
`session_meta.payload.id` and remained bound to the same DevSpace session across native Resume.
The persisted conversation was restored over multiple generations, including after deliberate
Agent loss and product workspace Stop recovery. Built-in launch and resume use
`codex --yolo --no-daemon`; clean foreground settlement left the private slot empty, the lease
released, and the home quiescent during a six-second observation.

The private-home lifecycle is bounded and Agent-owned. Live Unix sockets and the exact bounded
Codex daemon/app-server runtime state are omitted on writeback and rejected on materialization;
the bounded app-server package cache is treated as ephemeral. Codex artifacts use a verified
content-addressed in-container cache. Interactive PTYs start at 80x24, browser resize remains
authoritative, and failed resize operations have private diagnostics.

Fast-exit terminal output is retained in a 64 KiB replay buffer for one read-only claim within
30 seconds. Web authorizes a closed-terminal upgrade only inside that window, with exact
project/workspace/terminal ownership; the Agent decides whether replay remains available. Live
acceptance verified Web-to-Agent replay, exit code delivery, and denial of a second output claim.
The generic custom-harness smoke rendered `DEVSPACE_CUSTOM_HARNESS_OK` and `CODEX_HOME=unset`,
exited 0, and acquired no Codex-home lease or provider state.

Agent restart while foreground Codex was live preserved the exact running orphan, dirty slot, and
lease. Product workspace Stop safely finalized it; workspace Start and subsequent Resume
restored the same conversation. Workbench selection remains bound to the selected DevSpace
session ID through projection refreshes. The structured Codex path has not been retired.

## Delivery status

Milestones 0 and 1 are complete. PR #43 / AI Session Beta Checkpoint 1 and PR #47 / private
GitHub access are merged. CP3A/CP3B private GitHub access is complete, including real-provider
private Push and non-fast-forward rejection acceptance. The private GitHub infrastructure phase is
closed. Workbench 1A Files + Monaco merged as PR #48 at
`e96afb4ac37b05099af1b6f8b7639677d0482113`, and the browser smoke passed. Workbench 1B Changes +
Commit is merged by PR #49 at `47bf2d8c70dcab7b2ff278eb241e927db02a6dd0`.

Private GitHub Repository Access Checkpoint 1 was merged by PR #44 at
`a74c183e5dc9cf3ed1bf9c9ac4513cb7cdcf126e`. The validated CP1 head was
`ea5fbbeeb17be0ec393097be1e5dd6374b9bb356`; the accepted CP1 snapshots were proven tree-identical.
Real CP1 local/dev GitHub App acceptance is complete. This document does not claim production
deployment or production-provider acceptance.

## Canonical AI-session merge proof

The validated PR #43 head and squash-merged `main` commit have the same exact repository snapshot:

- validated PR head: `a53fdd27907b28df356b2a116d9c1e0860ad54e9`;
- merged `main`: `6efab35bc4417db969724b4f038c7df49f2076fb`;
- shared root tree object: `5a3fec979ddcccf41caafd38cdb9db7f282cf570`.

The proof was obtained with:

```bash
git rev-parse 'a53fdd27907b28df356b2a116d9c1e0860ad54e9^{tree}'
git rev-parse '6efab35bc4417db969724b4f038c7df49f2076fb^{tree}'
```

Both commands returned `5a3fec979ddcccf41caafd38cdb9db7f282cf570`. The repository snapshots
are therefore identical even though squash merging changed commit history.

## Durable AI-session guarantees

The merged owner-controlled Codex session path uses one Agent-owned persistent authority beneath
the configured Agent state root, an exclusive provider lease, exact-container ephemeral credential
staging, bounded strict stdio, durable public session/turn/event history, and restart reconciliation.
The browser can create/select persisted sessions, send and stream turns, cooperatively interrupt,
answer bounded approvals and structured questions, view bounded changed-file summaries, stop, and
restart an exactly stopped session when its profile revision still matches. Web remains the sole
SQLite writer; provider credentials, native interaction IDs, and private execution state remain
Agent-owned.

AI Session Beta Checkpoint 2 is implemented on `feat/ai-workbench-checkpoint-2`: durable interaction
projection and terminal retirement, canonical response reconciliation, profile-pinned session
navigation, and changed-file opening through the existing Workbench editor/Changes views are in
place. The branch also derives Codex compatibility from the inspected protocol/capability surface:
Codex `0.145.0` is the minimum regression baseline with no upper version bound, compatibility
probing is isolated from Agent-host privileges, and the exact recognized execution-artifact closure
is bound through discovery and launch. Command/file approvals remain required for the writable
profile; structured input and interrupt may degrade only when the discovered protocol proves they
are unavailable. Existing sessions remain pinned to their profile revision across Codex updates.
The deterministic browser fixture covers the workflow; the configured official Codex `0.153.4`
was admitted through the isolated discovery path with the required capabilities. Full real-browser
dogfood remains blocked until an operator completes the isolated device-login step for the fresh
Agent-owned authority. A bounded deployment/admin bootstrap now performs that step inside a
dedicated rootless Docker container and installs the validated result through the existing Agent
lease and atomic writeback path; no credential bypass is permitted.

The Codex readback helpers now have explicit linux-x64 provenance: reviewed C sources are built
inside the digest-pinned `gcc:13.3.0-bookworm` builder, canonical binaries are checked by their
independent trusted SHA-256 identities, and Agent packaging copies only those verified artifacts.
The reproducibility check builds twice from clean output and compares both bytes and hashes with
the canonical and packaged copies. Codex turns also explicitly retain `on-request`/`user`
approval authority with a workspace-write sandbox rooted at `/workspace`.

## Durable Milestone 1 and product path

Milestone 1 is complete. The durable product path is an owner-controlled browser workflow: Web is
the sole SQLite writer; the Agent owns filesystem, Git, Docker, PTY, task, preview, and provider
authority; and the browser communicates only with Web over contract-validated routes. The TypeScript
7 acceleration slice is complete without changing runtime authority boundaries.

The implemented M1 path includes trusted HTTPS repository onboarding, Agent-managed bare fetch
stores and independent workspace repositories, immutable Project Options and runtime-plan
compilation, the dedicated rootless Docker workspace lifecycle, browser terminal and structured
foreground tasks, and normal Web/Agent restart reconciliation. Projects retain explicit
registering/ready state and exact ownership records; unowned or drifted resources fail closed rather
than being adopted.

The preview path is workspace-targeted and loopback-only. Agent-owned leases, exact workspace and
generation identities, the private Caddy adapter, and the gateway-host probe keep Docker sockets and
arbitrary upstreams out of the gateway. The generic gateway Compose contract uses administrator-
precreated external volumes and private Unix sockets. The Coolify Raw Compose connector is attached
to the selected Traefik network through the reserved `devspace-preview-ingress` alias, while Caddy
and the gateway host remain isolated from Docker. The production-specific outer path is Coolify
Traefik → Cloudflare Tunnel/Access → reserved preview namespace → connector → Caddy → exact
loopback lease; this deployment choice is not a universal DevSpace core requirement.

The current dashboard and Workbench expose project onboarding, workspace runtime controls, terminal,
tasks, previews, AI sessions, and the Agent-backed Files + Monaco editor slice. File browsing,
editing, and the Workbench 1B Git Changes + Commit workflow remain available when the Docker runtime
is stopped.

Workspace Git metadata now lives inside each workspace at `.devspace-git`, so `/workspace` is a
complete Git repository in managed containers. Each workspace owns copied objects and private refs;
the Agent bare repository remains the authenticated fetch cache, and the Agent retains authenticated
Push authority. Existing linked-worktree metadata migrates on Start only after the Agent confirms the
container is stopped or absent, preserving local commits and index/worktree changes. Agent typecheck
and the full Agent suite pass. The real rootless-Docker acceptance test needs a configured dedicated
test daemon and was skipped in this environment.
The confirmed Workbench 1B dogfood corrections reconcile stale Changes entries, preserve unsaved
editor buffers across Edit/Changes presentation toggles, and use deterministic local Monaco model
identity and disposal ownership.
Workbench 1B adds bounded status/diff inspection, staged and unstaged groups, file-level stage and
unstage, explicit staged-only commits with bounded identity inputs, branch/ahead/behind context, and
the existing explicit Fetch and Push actions. Persistent Git mutation failures require explicit
dismissal; non-fast-forward Push failures direct the user to Fetch, integrate, and explicitly Push
again without automatic retry. Snapshot observation now isolates bounded Git-state failures to the
affected workspace, preserves successful mutations when a later refresh is stale, and recovers Agent
observation health after a later successful refresh. On Agent startup, interrupted `running`
`project.git.stage`, `project.git.unstage`, and `project.git.commit` records are durably
terminalized as non-retryable `GIT_MUTATION_OUTCOME_UNCERTAIN` failures and are never replayed;
`accepted` local Git mutations remain resumable because they may not have started. A live-process
mutation that is known to have completed but cannot settle observation or its journal remains
recoverable, preserving mutation truthfulness until restart reconciliation. Project creation from
scratch, persistent terminals, and later Workbench polish remain deferred product work.

## Private GitHub Repository Access status

Checkpoint 2 is merged and its real-provider acceptance completed successfully. The accepted merge
proof is:

```text
PR #45
accepted PR head:
a9dabaece59ea9927ebb5a62767849cda96245ff

squash merge:
3ffd07fad4995ac73bb2dccc1514bf5cb5fe5193

shared root tree:
9647bd27929a7300aaa627416f8111f447b68899
```

Checkpoint 3A/3B are complete. PR #47 merged the durable connection lifecycle generations, explicit
disconnect, bounded cleanup settlement, same-ID reconnect/re-authorization, authoritative
upstream-loss classifications, and explicit private Push. Real-provider private Push and
non-fast-forward rejection passed acceptance. The private GitHub infrastructure phase is closed;
this document does not claim production deployment.

The authority model remains App-only: no user OAuth, OAuth client secret, user access token, PAT,
Git password, or browser account discovery exists. Administrator configuration supplies one expected
account numeric ID and account type; login names are display metadata only. The callback state is a
one-time 32-byte value whose SHA-256 hash is the only persisted state value. The authenticated Web
actor, ten-minute expiry, and pending/claimed/connected/failed attempt lifecycle are bound in
SQLite. Claims use an immediate compare-and-swap transaction, and every Web use of a connection ID
joins the retained connection to its originating actor-owned connection attempt.

The Agent verifies `/app` and the exact installation with an App JWT, proves the App ID, exact
installation ID, configured account ID/type, active status, repository-selection mode, and minimum
metadata permission, then stores only safe installation metadata in the private binding. Each
authenticated private Git operation is fenced by the retained connection's lifecycle generation,
repeats the live proof, requires current Contents read, resolves the exact numeric repository ID,
mints one fresh exact-repository read token, and revokes/settles it independently. The
Agent-private layout extends the existing configured state root:

```text
<agent-state-root>/github-app/
├── config.json
├── private-key.pem
├── installations/<connection-id>.json
├── token-leases/<connection-id>.json
└── lifecycle/<connection-id>.json
```

SQLite retains the stable `connection_id`, a monotonic `lifecycle_generation`, admission state,
cleanup state, and the last safe authority classification. A reconnect or replacement GitHub
installation updates that retained row and keeps the same DevSpace connection ID. A separate
setup-attempt table preserves the original actor-owned connection attempt as the ownership anchor
while keeping a pending reconnect visible beside the retained connection.

The existing Agent-private conventions are reused: Agent-owned `0700` directories; no-follow
descriptor reads; regular, single-link, owner-owned `0600` files; bounded nonzero sizes; stable
device/inode/size/mode/owner/link-count checks before and after reading; exact-byte UTF-8 and schema
parsing; and same-directory atomic fsync/rename writes. Startup validates configuration, key,
bindings, and nonsecret leases before exposing GitHub authority. Every installation and lease record
is bound to its exact path identity: the canonical UUIDv7 filename stem, embedded `connectionId`,
and requested connection ID must agree; malformed names or mismatches fail closed at startup and at
runtime. The private key and all tokens stay
inside Agent memory/private storage; SQLite, browser responses, logs, errors, URLs, arguments, and
ordinary environment values contain no reusable credential.

Repository listing remains serialized per connection and requests only `metadata: read`. Exact Git
requests use the deliberately bounded lossless-ID request serializer, require the exact repository
authority in GitHub's scoped response, and derive `https://<owner>/<name>.git` locally. The token
never enters a URL, argv, persistent environment, Git config, journal, SQLite, browser response,
workspace, or log. A short owner-private runtime directory under `$XDG_RUNTIME_DIR` (then
`/run/user/<uid>`, then an unpredictable `/tmp` directory) holds the broker socket. The broker
binds a random 256-bit operation capability to the connection, repository, Agent operation,
execution ID, process-group evidence, deadline, and exact prompt sequence. The native helper emits
only the requested username or password.

Clone and authenticated fetch use the normal managed bare store; fetched remote-tracking refs are
also synchronized into each independent workspace repository. Private ownership
records retain `{connectionId, repositoryId}` and v2 origin-transition state; a rename retaining the
same numeric ID may transition only through the exact recorded old/new clean HTTPS pair. Browser
Fetch repository starts a distinct operation and retries accepted/running operations by the same
operation ID. Public HTTPS onboarding, clone, fetch, inspection, and local worktree operations remain
on their existing unauthenticated path.

The focused suite covers live refresh, actor ownership, immutable IDs larger than
`Number.MAX_SAFE_INTEGER`, exact mint scope and permission validation, stale/missing permissions,
installation/repository removal, token-lease uncertainty and degraded cleanup, long-path broker
startup, stale sockets, helper protocol failures, hostile Git environment/configuration, canary
non-disclosure, authenticated Git fixtures, managed-store transitions, browser routes, and atomic
Web persistence. It uses ephemeral keys, temporary private state, local authenticated Git fixtures,
injected transport/response seams, and deterministic failure seams only; it does not use real
GitHub private keys or installation tokens.

Disconnect removes only the exact Agent-private installation binding after active token work and
lease settlement; it never removes projects, source metadata, managed stores, worktrees, workspace
files, commits, dirty changes, or runtime state. Pending cleanup remains visible when the Agent is
unavailable, and stale refreshes or callbacks cannot re-enable an older generation. The browser
offers minimal disconnect confirmation and reconnect/re-authorize guidance.

CP3B explicit private GitHub push was merged in PR #47. The Workbench Push action prepares a
server-captured `{connectionId, repositoryId, branch, commit,
generation}` intent, requires explicit confirmation, and dispatches only the fixed same-name
`<commit>:refs/heads/<branch>` update through exact `contents:write` GitHub App authority. The
destination is the live authority-resolved HTTPS origin URL, and repository-local push
destination/rewrite settings are rejected. Read operations retain their read-only scopes. Missing write permission follows the existing
permission-loss/reauthorization path. Submitted or interrupted pushes are terminalized as
`GITHUB_PUSH_OUTCOME_UNCERTAIN`, retain their captured intent for inspection, and are never
automatically resent. Agent snapshot reconciliation also clears a submitted Web operation after
an Agent restart. The private GitHub infrastructure phase is complete; this document does not
claim production deployment.

CP3B intentionally does not include force push, force-with-lease, tag or branch deletion, arbitrary
refspecs/remotes, branch-management, merge/rebase, conflict resolution, or a general remote-effect
reconciliation framework. Installation deletion, repository creation, PAT/OAuth fallback, generic
provider abstraction, webhooks, GitHub Enterprise, multiple identities, manual authenticated Git
inside workspace containers, hostile same-UID/multi-tenant hardening, and production deployment
remain outside this slice.
