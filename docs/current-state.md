# Current State

## Delivery status

Milestones 0 and 1 are complete. PR #43 / AI Session Beta Checkpoint 1 is merged. The current
objective is the finished owner-controlled MVP, and private GitHub repository access is the active
slice.

Private GitHub Repository Access Checkpoint 1 is implemented on
`feat/private-github-access`. It is not merged, deployed, or accepted against a real production
GitHub App. Checkpoints 2 and 3 remain pending.

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
The browser can create a session, send and stream turns, cooperatively interrupt, view bounded
changed-file summaries, stop, and restart an exactly stopped session. Web remains the sole SQLite
writer; provider credentials and private execution state remain Agent-owned. Approvals and
structured questions remain deferred to AI Session Beta Checkpoint 2.

## Durable Milestone 1 and product path

Milestone 1 is complete. The durable product path is an owner-controlled browser workflow: Web is
the sole SQLite writer; the Agent owns filesystem, Git, Docker, PTY, task, preview, and provider
authority; and the browser communicates only with Web over contract-validated routes. The TypeScript
7 acceleration slice is complete without changing runtime authority boundaries.

The implemented M1 path includes trusted HTTPS repository onboarding, managed bare stores and
primary worktrees, immutable Project Options and runtime-plan compilation, the dedicated rootless
Docker workspace lifecycle, browser terminal and structured foreground tasks, and normal Web/Agent
restart reconciliation. Projects retain explicit registering/ready state and exact ownership
records; unowned or drifted resources fail closed rather than being adopted.

The preview path is workspace-targeted and loopback-only. Agent-owned leases, exact workspace and
generation identities, the private Caddy adapter, and the gateway-host probe keep Docker sockets and
arbitrary upstreams out of the gateway. The generic gateway Compose contract uses administrator-
precreated external volumes and private Unix sockets. The Coolify Raw Compose connector is attached
to the selected Traefik network through the reserved `devspace-preview-ingress` alias, while Caddy
and the gateway host remain isolated from Docker. The production-specific outer path is Coolify
Traefik → Cloudflare Tunnel/Access → reserved preview namespace → connector → Caddy → exact
loopback lease; this deployment choice is not a universal DevSpace core requirement.

The current dashboard and Workbench expose project onboarding, workspace runtime controls, terminal,
tasks, and previews. File editing, richer Git controls, persistent terminals, project creation from
scratch, and later Workbench polish remain post-M1 product work.

## Private GitHub Checkpoint 1 state

This branch implements Checkpoint 1 and remains a draft, unmerged, undeployed branch. It has not
received real production GitHub App acceptance. The authority model is App-only: no user OAuth,
OAuth client secret, user access token, PAT, Git password, or browser account discovery exists.
Administrator configuration supplies one expected account numeric ID and account type; login names
are display metadata only.

The callback state is a one-time 32-byte value whose SHA-256 hash is the only persisted state value.
The authenticated Web actor, ten-minute expiry, and pending/claimed/connected/failed attempt lifecycle are
bound in SQLite. Claims use an immediate compare-and-swap transaction. Exact duplicate callbacks
with the same installation ID are resumable, a conflicting ID is rejected, and a Web persistence
failure after Agent binding can be retried against the same private binding. The browser-facing
projection maps internal `claimed` to `pending`; internal persistence states are never returned as
public connection states.

The Agent verifies `/app` and the exact installation with an App JWT, proves the App ID, expected
account ID/type, active installation, repository selection, and the minimum `metadata` permission,
then stores only safe installation metadata in the private binding. The Agent-private layout extends
the existing configured state root:

```text
<agent-state-root>/github-app/
├── config.json
├── private-key.pem
├── installations/<connection-id>.json
└── token-leases/<connection-id>.json
```

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

Repository listing is serialized per connection and requests only `metadata: read`. The installation
token is minted immediately before the bounded installation-repository request, never persisted,
revoked immediately, and dropped from memory. Production HTTP reads inspect and conservatively
validate `Content-Length`, consume Web Streams incrementally by byte count, cancel at the bound,
and apply fatal UTF-8 decoding before JSON parsing. A mint response is definitive only when a
complete bounded GitHub rejection proves no token; a transport failure, malformed/oversized
response, or incomplete `201` response is uncertain. Uncertain minting retains a conservative
nonsecret guard through the maximum token lifetime and blocks overlapping minting. The internal
lifecycle records primary listing outcome, revocation outcome, lease settlement, and binding-health
persistence separately. A successful page remains successful when cleanup is degraded; the response
carries only bounded `cleanupDegraded` state, while a stale guard remains until proven cleanup or
expiry.

Inspection derives effective health from the durable binding and lease state. A lease recovered at
startup, a persisted cleanup-degraded lease, an unproven local settlement, or a binding-health write
failure reports `degraded` even when the durable binding still says `connected`; a safely owned
in-process lease does not by itself change ordinary status inspection. After a guard expires (or
cleanup is otherwise proven), only a later successful listing with proven revocation, local
settlement, and binding restoration may persist `degraded` back to `connected`; expiry alone does not.
The browser can connect, retry, view the verified identity, list safe repository metadata, and
paginate with bounded opaque continuations. Private inspection,
clone, fetch, workspace creation, onboarding selection, credential brokering, push, disconnect, and
webhooks are not part of this checkpoint.

The focused suite covers App/account authority, minimum permissions, ambiguous mint results and
restart blocking, bounded production response reads, exact record/path identity, cleanup persistence
failures, degraded recovery across restart, validated-byte parsing, callback claim concurrency, Web
persistence retry, public status projection, strict contracts, malformed upstream repository
identities, and the browser-safe connection/listing surface. It uses ephemeral keys, temporary
private state, injected transport/response seams, and deterministic failure seams only; no real
GitHub credentials or network are required.

## Limitations and deferred work

- No private repository inspection, clone, fetch, workspace creation, onboarding selection, Git
  credential broker, askpass helper, or push exists yet.
- No disconnect, installation deletion, webhook handling, GitHub Enterprise, multiple owner
  identities, or browser account configuration exists.
- External uninstall, suspension, permission reduction, and repository-selection changes remain
  GitHub-authoritative: connection setup proves the configured installation, and later listing must
  succeed through that installation's current token/API authority. No webhook dependency exists.
- Checkpoint 2 will cover private inspect/clone/fetch/workspace creation and bounded credential
  brokering. Checkpoint 3 will cover explicit push and disconnect/revocation behavior.
- This branch has automated fake-transport, filesystem, persistence, contract, route/UI, and browser
  coverage only. It does not claim deployment or real production GitHub App acceptance. The AI smoke
  was not rerun for this correction.
