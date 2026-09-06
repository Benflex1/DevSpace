# DevSpace Private GitHub Repository Access — Checkpoint 2 Design

## Goal

Deliver one browser-usable owner-only vertical slice for registering, cloning,
fetching, inspecting, and starting a private GitHub repository through the
retained GitHub App installation without exposing an installation token or
allowing browser-controlled repository substitution.

## Boundaries

The browser communicates only with Web. Web owns SQLite and actor authorization.
The Agent owns GitHub App secrets, live installation proof, Git, managed stores,
the credential broker, and private runtime state. GitHub App sources are
authorized only by the immutable pair `{ connectionId, repositoryId }`.
Public HTTPS sources keep their existing URL-based behavior. Push, disconnect,
installation deletion, PAT/OAuth fallback, webhooks, GitHub Enterprise, and
authenticated Git inside workspace containers remain outside this checkpoint.

## Architecture

### Authority chain

Web accepts a GitHub source identity only as a validated connection ID and
canonical decimal repository ID. Before every Web use of a connection ID, a
database query joins `github_connections` to its originating
`github_connection_attempts` row and requires the authenticated actor to match
`created_by`. The Agent then loads its private binding by connection ID and
re-proves the configured App, exact installation, configured numeric account,
account type, suspension state, repository selection, and current permissions.
The browser never submits owner, repository name, full name, or URL for this
source variant.

The Web database stores safe GitHub repository metadata in
`project_github_sources`, while the Agent store-ownership record stores the
exact source locator. Names and URLs are refreshable metadata; the numeric
repository ID and connection ID are the only repository authority.

### Live GitHub authority and token lifecycle

CP1's per-connection lease and cleanup state machine is retained and factored
around one operation-local token transaction. Listing requests a fresh
metadata-only installation token. Private Git requests a fresh token scoped to
exactly one repository and exactly `contents: read`. No token is pooled,
reused, persisted, logged, included in an error, or returned to Web.

The installation refresh operation creates an App JWT, verifies `/app`, loads
the exact installation, validates all configured authority fields, and persists
the safe permission snapshot while preserving cleanup-degraded state. Missing
`contents: read` leaves the connection listable but blocks private Git before
token minting. Uncertain minting, restart recovery, revocation degradation,
lease persistence failure, and proven recovery preserve CP1's conservative
semantics.

GitHub decimal IDs are represented internally as validated canonical strings.
The upstream response parser is a bounded JSON tokenizer that retains numeric
tokens as decimal text; it does not use `JSON.parse` followed by unsafe number
coercion or a regular-expression rewrite. The exact Git token request uses a
bounded serializer with one explicitly approved raw numeric insertion from the
validated decimal-ID value, producing `repository_ids` as a JSON number rather
than a JSON string. Exact token responses must contain one and only one scoped
repository with the requested numeric ID and effective Contents permission
exactly `read`.

### Askpass broker

The Agent creates a private broker runtime directory under `$XDG_RUNTIME_DIR`
when it is an absolute, owner-controlled usable directory; otherwise it tries
`/run/user/<uid>` when that directory is safely owner-controlled; otherwise it
creates an unpredictable owner-only `0700` directory under `/tmp`. The final
socket pathname is deliberately bounded below the Unix-domain socket limit and
is independent of the durable Agent state path.

Socket startup and shutdown use `lstat` identity checks, owner/mode checks,
active-listener probing, and stale removal only after the exact socket identity
is rechecked. Non-socket, changed, unowned, or uncertain paths fail closed.

Each authenticated Git execution registers a random 256-bit capability in
Agent memory. The registration binds connection ID, repository ID, Agent
operation ID, execution identity, Git process identity when available, a
deadline, and the two permitted prompt classes. A native statically linked
helper receives Git's prompt, sends one bounded framed request containing only
the capability and process metadata, and writes only the requested credential
to stdout. The broker permits one username response (`x-access-token`) and one
password response (the in-memory installation token), rejects all other,
duplicate, malformed, oversized, expired, or unrelated requests, and removes
the registration as soon as Git settles.

### Authenticated Git environment

Authenticated Git is spawned with a positive allowlist rather than inherited
`process.env`. Git and SSH askpass/config overrides, alternate config paths,
credential helpers, trace variables, proxy/SSH command variables, alternate
HOME/XDG paths, hooks, redirects, and arbitrary protocols are stripped or
neutralized. The approved environment sets `GIT_TERMINAL_PROMPT=0`, the trusted
absolute askpass helper, `SSH_ASKPASS=/bin/false`, controlled nonexistent
`HOME` and `XDG_CONFIG_HOME`, `GIT_CONFIG_NOSYSTEM=1`, and fixed locale/PATH
values. Command-level config resets `credential.helper`, enables
`credential.useHttpPath`, disables hooks/submodules/interactive fallback, and
allows only canonical HTTPS.

### Managed store and rename transition

GitHub store creation resolves the exact repository, derives the clean URL
locally from validated owner/name, mints a fresh exact token, and performs the
bare clone through askpass. The persisted remote contains only the clean HTTPS
URL. Fetch repeats live authority proof, exact resolution, fresh token minting,
and askpass delivery. Local `update-ref`, `rev-parse`, worktree, status, and
inspection operations never mint credentials.

Store ownership is versioned. Public version-1 records remain readable. New
records can carry the GitHub source locator and a pending origin transition.
For a rename with the same repository ID, the Agent persists the old origin and
pending derived origin, updates Git's origin, then persists the new origin and
clears the pending value. Restart recovery accepts only that exact old/new
pair; any third URL is an ownership conflict.

### Web/browser flow

The Add Project form has HTTPS and Connected GitHub repository modes in one
surface. GitHub mode shows the retained verified account, current Contents
status, refresh control, and authorized repositories. Archived or disabled
entries cannot be selected. Registration sends only `{ connectionId,
repositoryId }` plus project name/slug/selected branch. Web resolves current
safe metadata through the Agent and atomically inserts the project and source
row. The existing Project Options/setup pipeline then receives the immutable
source locator and creates the normal managed store, primary worktree, and
ordinary runtime.

The Workbench adds a small authenticated `Fetch repository` action. Active
accepted/running fetches reconcile the same operation; terminal operations get
a new operation ID. Initial setup fetch and later browser fetch remain
distinct. The route does not become a general Git UI.

## Failure model

The Agent exposes stable, safe failures for missing Contents permission,
unavailable/suspended installation, unauthorized/unselected repository,
rejected fresh Git credentials, active token leases, and ordinary source
unavailability. Upstream bodies, JWTs, installation tokens, and broker
capabilities never cross the public failure boundary.

## Verification strategy

Tests are added before each implementation slice. They cover contract/schema
identity, actor ownership, atomic persistence, live refresh, permission
states, lossless large IDs, exact token request/response validation, all lease
outcomes, broker protocol and socket lifecycle, hostile Git environments,
canary-token surfaces, real Git plus native askpass integration, clone/fetch/
inspection/rename/restart behavior, Web routes, browser onboarding/setup/fetch,
and unchanged public flows. The complete repository contract and focused
Playwright/browser and authenticated-Git suites run before the branch is
declared complete.
