# testkit

`@devspace/testkit` is private, development-only infrastructure for deterministic
unit tests. It has no production dependencies and is never a runtime dependency
of an application or production package.

Its public entry point is the package root:

- `withTemporaryDirectory(callback)` creates an isolated operating-system
  temporary directory, passes its absolute path to the async callback, and
  removes it in `finally`.
- `loadJsonFixture(input)` reads UTF-8 JSON from an absolute path or `file:` URL
  and returns `unknown`. Filesystem and JSON parser failures are allowed to
  surface unchanged.

The package is built to `dist/` for its future public entry point, while the
Vitest and TypeScript test configurations resolve `@devspace/testkit` directly
to `src/index.ts` during clean-clone tests.
