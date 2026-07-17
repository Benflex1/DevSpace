# Workspace agent

The Agent is a private HTTP/1.1 service over `/run/devspace/agent.sock` by default. This slice
implements contract-backed health and non-mutating remote Git source inspection only. It never
opens SQLite and does not yet create managed repositories, worktrees, containers, or processes.

`pnpm dev` starts Agent and Web together for local development. `pnpm dev:agent` starts Agent alone
on `.devspace-local/agent.sock`. The production entrypoint is
`pnpm --filter @devspace/agent start` after `pnpm build`.

Source inspection currently permits HTTPS Git repository URLs without query parameters. SSH
inspection remains disabled until a separately designed identity and known-host boundary exists.
