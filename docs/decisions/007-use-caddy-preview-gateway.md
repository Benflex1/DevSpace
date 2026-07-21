# ADR 007: Delegate previews to Caddy

- Status: Accepted

> Superseded in part by ADR 014: Caddy remains the exact DevSpace route owner, but an outer ingress
> may be provider-selected and forwards only the reserved preview namespace through the private
> connector. The former exclusive wildcard/Cloudflare deployment assumption is historical.


## Context
DevSpace requires dynamic HTTP, WebSocket, and HMR routing but should not implement a reverse proxy.

## Decision
Use Caddy behind Cloudflare Tunnel. The agent manages a narrow DevSpace-owned route namespace.

## Consequences
Proxy behavior remains mature and replaceable. Gateway administration must remain private.
