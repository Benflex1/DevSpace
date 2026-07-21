# ADR 008: Separate preview and control-plane origins

- Status: Accepted

> Superseded in part by ADR 014: preview/control-plane origin separation remains required, while
> preview ingress is no longer required to be Cloudflare-only or an exclusively DevSpace-owned
> wildcard.


## Context
Preview applications run project-controlled JavaScript and must not share control-plane authentication cookies.

## Decision
Use a dedicated preview parent, preferably a separate registrable domain, protected by Cloudflare Access. Use host-only control-plane cookies.

## Consequences
Cross-origin integration must be explicit. Each approved preview base needs wildcard DNS, Tunnel, TLS, and Access configuration.
