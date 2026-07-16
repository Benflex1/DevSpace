# DevSpace

DevSpace is a self-hosted, single-user, AI-first development control plane. Each project is
intended to have a managed primary workspace in an isolated development environment.

Milestone 0 — the executable architecture, contracts, validation primitives, database foundation,
and clean-clone verification contract — is complete. The product runtime is not implemented yet.

Development now proceeds through vertical slices toward a usable primary workspace: browser
onboarding, a managed worktree, an isolated runtime, terminal/tasks, and previews. See
[`docs/roadmap.md`](docs/roadmap.md) for the current delivery direction.

The accepted boundaries remain: the browser talks only to the web application; the web application
owns SQLite writes; the agent owns filesystem, Git, PTY, and dedicated rootless-Docker operations;
project containers receive only declared workspace inputs; and DevSpace never auto-merges or deploys
production changes.
