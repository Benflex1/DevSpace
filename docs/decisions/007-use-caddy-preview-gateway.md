# ADR 007: Delegate previews to Caddy

- Status: Accepted


## Context
DevSpace requires dynamic HTTP, WebSocket, and HMR routing but should not implement a reverse proxy.

## Decision
Use Caddy behind Cloudflare Tunnel. The agent manages a narrow DevSpace-owned route namespace.

## Consequences
Proxy behavior remains mature and replaceable. Gateway administration must remain private.
