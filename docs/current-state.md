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

## Private GitHub Checkpoint 1 authority

The connection uses a GitHub App only. There is no GitHub user OAuth, OAuth client secret, user
access token, personal access token, Git password, or account discovery flow. Administrator
configuration binds authority to an expected GitHub numeric account ID and account type; the login
is display metadata only.

Web creates a UUIDv7 connection attempt and a 32-byte random one-time state with a ten-minute
expiry. SQLite stores only its SHA-256 hash, the authenticated Web actor, bounded lifecycle fields,
the untrusted claimed installation ID, safe verified connection metadata, and row versions. The
callback accepts only `state`, `installation_id`, and recognized `setup_action` values. Its state
claim is an immediate SQLite transaction with compare-and-swap semantics. Exact duplicate callbacks
resume safely; foreign, expired, conflicting, malformed, or failed claims fail closed.

The Agent mints a short-lived App JWT, verifies `GET /app`, retrieves the exact installation through
App authority, checks App ID, expected account numeric ID and type, suspension, repository selection,
and bounded permissions, then persists the binding before Web marks the connection connected.
Restart or a Web persistence failure can reconcile through the same connection/installation pair.

## Agent-private GitHub state

The implementation extends the existing configured Agent state root; it creates no second root:

```text
<agent-state-root>/github-app/
├── config.json
├── private-key.pem
├── installations/<connection-id>.json
└── token-leases/<connection-id>.json
```

`github-app` is administrator-provisioned. `config.json` contains only the App numeric ID, expected
account numeric ID/type, and canonical installation URL. `private-key.pem` never leaves Agent-private
storage. The Agent creates the `installations` and `token-leases` children.

The implementation reuses the Agent's strict private-state conventions: Agent-owned `0700`
directories; no-follow descriptor reads; regular, single-link, Agent-owned `0600` files; bounded
sizes; before/after descriptor identity checks; strict runtime schemas; and same-directory atomic
write, file fsync, rename, and directory fsync. Startup validates all configured material, bindings,
and nonsecret leases before exposing GitHub authority. Installation bindings survive restart;
installation tokens do not.

## Installation token lifecycle

Repository listing obtains the installation ID only from the verified Agent-private binding. For
each serialized operation, Agent first records a nonsecret mint guard, mints one installation token
with only `metadata: read`, records its expiry and active phase, calls the bounded installation
repository endpoint, attempts immediate revocation, drops the in-memory token reference, and settles
the guard.

Primary outcome and credential-cleanup outcome are separate. If listing completes but revocation
fails, the completed repository page remains the primary success, `cleanupDegraded` is reported
separately, the private binding becomes degraded, the token reference is dropped, and the nonsecret
guard remains until proven cleanup or token expiry. Restart reloads that guard and blocks overlapping
minting. A retry is not represented as necessary to repair the completed listing. If listing did not
complete, its bounded primary failure remains truthful; revocation is still attempted and uncertain
cleanup still blocks minting. No guard contains a token, Authorization header, or reusable derived
credential.

## Browser-visible Checkpoint 1 behavior

The dashboard shows unconfigured, disconnected, pending, connected, degraded, or failed GitHub App
state as applicable. The owner can begin installation, return through the authenticated setup
callback, see the verified account identity, list authorized repositories, paginate, and retry a
failed connection attempt. Repository projections contain only stable numeric ID, owner/name/full
name, a canonical credential-free `https://github.com/<owner>/<name>.git` URL, default branch, and
private/archived/disabled flags.

## Limitations and deferred work

- No private repository inspection, clone, fetch, workspace creation, onboarding selection, Git
  credential broker, askpass helper, or push exists yet.
- No disconnect, installation deletion, webhook handling, GitHub Enterprise, multiple owner
  identities, or browser account configuration exists.
- External uninstall, suspension, permission reduction, and repository-selection changes are
  revalidated during Agent operations; no webhook dependency exists.
- Checkpoint 2 will cover private inspect/clone/fetch/workspace creation and bounded credential
  brokering. Checkpoint 3 will cover explicit push and disconnect/revocation behavior.
- This branch has automated fake-transport, filesystem, persistence, contract, route/UI, and browser
  coverage only. It does not claim deployment or real production GitHub App acceptance.
