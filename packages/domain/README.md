# domain

Pure lifecycle state machines, contextual lifecycle invariants, and the authoritative Git branch
shorthand grammar shared by contracts and security.

The public API exposes closed state unions, state tuples, and lifecycle-specific transition
functions for all complete Milestone 0 graphs. Transition tables are private implementation
details whose objects and destination collections are frozen at runtime. Expected invalid edges
and contextual guard failures return discriminated results; the package performs no persistence,
orchestration, filesystem, Git, container, process, terminal, preview-route, or provider operations.

`validateGitBranchShorthand` accepts or rejects the exact foundation branch representation and
returns a closed stable reason code plus structured component details. It is lexical only: it does
not invoke Git, resolve a ref, or prove that a branch exists.
