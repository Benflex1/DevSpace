# Workspace agent

Future ownership:

- managed repository stores and Git worktrees;
- dedicated rootless Docker runtime;
- workspace stacks and supporting services;
- predefined tasks, processes, PTYs, and AI CLIs;
- health checks, logs, port leases, and Caddy routes;
- runtime reconciliation.

The agent is private and communicates with the web application through a Unix domain socket.
