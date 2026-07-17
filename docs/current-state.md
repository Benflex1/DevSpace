# Current State

## Current milestone

Milestone 1 — in progress.

## Implemented product path

- Browser project onboarding in the Next.js Web application.
- Web-owned SQLite runtime access, committed migrations, project persistence, and audit events.
- Private Agent HTTP/1.1 transport over a Unix socket, including health and remote Git source inspection.
- Contract-validated Web-to-Agent requests and responses.
- Cloudflare Access JWT validation in production, with an explicit local development auth mode.
- Persisted projects are shown as `Registered — workspace setup pending` and remain in the
  `registering` state.
- Onboarding currently accepts HTTPS Git repository URLs without query parameters; SSH identities
  and repository credential storage are not implemented.

## Still absent

- managed repository stores and worktrees;
- workspace rows and primary workspace creation;
- Docker/runtime stacks;
- tasks, processes, terminals, previews, and AI sessions.

The next Milestone 1 slice begins managed primary workspace creation; onboarding does not claim
that a managed repository or workspace already exists.
