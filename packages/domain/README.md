# domain

Pure lifecycle state machines and contextual lifecycle invariants.

The public API exposes closed state unions, state tuples, and lifecycle-specific transition
functions for all complete Milestone 0 graphs. Transition tables are private implementation
details whose objects and destination collections are frozen at runtime. Expected invalid edges
and contextual guard failures return discriminated results; the package performs no persistence,
orchestration, filesystem, Git, container, process, terminal, preview-route, or provider operations.
