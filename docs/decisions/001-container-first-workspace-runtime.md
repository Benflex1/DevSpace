# ADR 001: Use one rootless container stack per workspace

- Status: Accepted


## Context
Host processes do not provide the project-level root access, dependency isolation, or service isolation required by the product.

## Decision
Every workspace, including the primary workspace, is instantiated as an independent stack in a dedicated rootless Docker daemon. The development container may provide root/passwordless sudo inside the container.

## Consequences
Projects can install and run tools freely without host permission problems. Runtime lifecycle and image management become first-class concerns. Root inside a workspace is not host root.
