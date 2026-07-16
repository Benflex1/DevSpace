# domain

Pure lifecycle state machines, contextual lifecycle invariants, and the authoritative Git branch
shorthand grammar shared by contracts and security.

The public API exposes closed state unions, state tuples, and lifecycle-specific transition
functions for all complete Milestone 0 graphs. Transition tables are private implementation
details whose objects and destination collections are frozen at runtime. Expected invalid edges
and contextual guard failures return discriminated results; the package performs no persistence,
orchestration, filesystem, Git, container, process, terminal, preview-route, or provider operations.

For F10 recovery contracts, the package also exposes narrow pure structural-edge predicates for
workspace, runtime-stack, service, service-health, process desired/observed, terminal, preview
desired/observed, and AI-session graphs. These predicates answer only whether a pair is an edge in
the authoritative graph. They share the same private transition tables as the contextual
validators and do not evaluate or fabricate recovery, dirty-state, route, ownership, or runtime
evidence.

`validateGitBranchShorthand` accepts or rejects the exact foundation branch representation and
returns a closed stable reason code plus structured component details. It is lexical only: it does
not invoke Git, resolve a ref, or prove that a branch exists.
