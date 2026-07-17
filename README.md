# DevSpace

DevSpace is a self-hosted, single-user, AI-first development control plane. Each project is
intended to have a managed primary workspace in an isolated development environment.

Milestone 1 is in progress. The first product slice now provides browser onboarding backed by real
SQLite persistence and real Agent inspection over a Unix socket. Registered projects remain in a
workspace-setup-pending state until the managed primary workspace slice.

Development now proceeds through vertical slices toward a usable primary workspace: browser
onboarding, a managed worktree, an isolated runtime, terminal/tasks, and previews. See
[`docs/roadmap.md`](docs/roadmap.md) for the current delivery direction.

The accepted boundaries remain: the browser talks only to the web application; the web application
owns SQLite writes; the agent owns filesystem, Git, PTY, and dedicated rootless-Docker operations;
project containers receive only declared workspace inputs; and DevSpace never auto-merges or deploys
production changes.

Run the usable local slice with `pnpm dev`, then open `http://localhost:3000`. Run its deterministic
browser test with `pnpm test:e2e`. Production authentication and runtime settings are listed in
`.env.example`.
