# ADR 014: Shared preview ingress with a reserved hostname namespace

- Status: Accepted

## Context

An exclusive wildcard base routed every subdomain to DevSpace and collided with ordinary
application hosts owned by an existing reverse proxy. Per-preview DNS, Cloudflare, Coolify, or
Traefik mutations would add provider coupling and operational race conditions.

## Decision

The administrator configures a closed preview-base registry containing `id`, `domain`, and a
required lowercase `labelSuffix` such as `-preview`. DevSpace composes
`<rendered-pattern-stem><labelSuffix>.<domain>` and owns exactly one leftmost DNS label matching
that namespace. Caddy continues to install exact Host routes only after Agent-owned lease and
health validation.

The dedicated Preview Gateway exposes its existing `127.0.0.1:18080` listener and a private HTTP
Unix socket at `gateway/ingress/preview-http.sock`. A small provider-neutral Node connector listens
only on an internal container port and forwards bytes to that socket. It mounts only the ingress
directory and receives no control or Docker sockets. The outer ingress is administrator-selected
and configured once for the reserved namespace.

## Consequences

Ordinary application hosts remain with the existing ingress, and no provider API integration is
needed. The administrator must provide DNS/TLS/access coverage, preserve Host, support WebSockets,
provision the private socket directory, and maintain one compatible outer-ingress rule. Persisted
preview hostnames are not silently migrated when the registry changes; Web-owned retirement and
rematerialization is required.

The production Web authentication implementation remains Cloudflare Access for now. Generic
provider-neutral production authentication is future work.

## Supersession

This ADR supersedes the provider-specific/exclusive wildcard portions of ADR 007 and ADR 008. Those
ADRs remain historical records of the earlier Caddy/Cloudflare and origin-isolation decisions.
