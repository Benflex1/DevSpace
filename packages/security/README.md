# security

`@devspace/security` owns side-effect-free Milestone 0 validation primitives. It currently
provides typed validation results and branded strings for repository-relative paths,
already-canonical absolute POSIX paths, Git branch shorthand, DNS labels, one-label preview
patterns, administrator-approved preview bases, and composed preview hostnames.

## Result contract

Expected validation failures return an immutable `ValidationResult<T>` with `ok: false`.
Every `SecurityValidationError` includes a category, stable closed error code, the original
string input, the affected field, the selected policy, and structured details where relevant.
Validation does not throw for ordinary rejected input and does not rewrite input before
returning a branded value.

The public error codes are grouped by these prefixes:

- `RELATIVE_PATH_*`: empty/NUL input, POSIX absolute, Windows drive/rooted/UNC/device forms,
  backslashes, traversal/current/empty segments, trailing separators, and file-required rules;
- `CANONICAL_PATH_*`: empty/NUL input, non-absolute or Windows forms, backslashes, dot/empty
  segments, and trailing separators;
- `GIT_BRANCH_*`: empty/control/whitespace input, forbidden syntax and characters, ambiguous
  slash/dot components, `.lock` components, and leading hyphens;
- `DNS_LABEL_*` and `APPROVED_BASE_*`: DNS label, base ID, base-label, and total-length rules;
- `PREVIEW_PATTERN_*`, `PREVIEW_BASE_*`, `PREVIEW_PLACEHOLDER_*`,
  `PREVIEW_GENERATED_LABEL_*`, and `PREVIEW_HOSTNAME_*`: pattern parsing and hostname
  composition failures.

`securityValidationErrorCodes` is a frozen public enumeration of the closed code union.

## Repository-relative paths

All accepted paths use `/` separators and are returned exactly as supplied. Validation is
lexical only and does not require the target to exist.

| Validator | Brand | `.` | Canonical nested relative path |
| --- | --- | --- | --- |
| `validateDockerfilePath` | `DockerfilePath` | rejected; a file path is required | accepted |
| `validateDockerBuildContextPath` | `DockerBuildContextPath` | accepted as repository root | accepted |
| `validateWorktreeWorkingDirectoryPath` | `WorktreeWorkingDirectoryPath` | accepted as repository root | accepted |
| `validateInstructionsFilePath` | `InstructionsFilePath` | rejected; a file path is required | accepted |

Each policy rejects empty input, NUL, absolute/drive-qualified/drive-relative/rooted/UNC/device
paths, backslashes, `..` and embedded `.` segments, duplicate separators, empty segments, and
trailing separators. It never trims, replaces slashes, folds case, percent-decodes, or applies
Unicode normalization. `/workspace` is the fixed development-container directory and is not a
repository-relative value accepted by these validators.

The file policies establish only that a non-root canonical relative spelling was supplied.
They do not prove that an existing object is a regular file.

## Canonical path relation

`validateClaimedCanonicalAbsolutePosixPath` brands a lexical absolute POSIX spelling that the
caller claims came from a future trusted canonicalization step. It rejects normalization
surprises such as dot segments, duplicate separators, backslashes, Windows forms, and trailing
separators other than `/`.

`compareCanonicalPathContainment` returns `equal`, `descendant`, or `outside` using segment-aware
comparison. The name deliberately does not claim authorization or safety. Neither function
reads the filesystem, resolves symlinks, verifies ownership, holds an open handle, or prevents a
time-of-check/time-of-use race. A future trusted agent must canonicalize both operands from the
filesystem and repeat containment validation immediately before acting.

## Git branch shorthand

`validateGitBranchName` preserves the F06 security result, brand, error, and field/policy contract
while delegating the authoritative lexical grammar and reason selection to `@devspace/domain`. It
rejects empty/control/whitespace values, backslashes, Git-forbidden
characters and sequences, ambiguous slash/dot components, `.lock` suffixes, a lone `@`, and a
leading `-`. It does not trim or normalize.

No general full-ref validator is exposed because the accepted Milestone 0 specifications do not
currently require one. Branch validation does not invoke Git and does not prove that a ref
exists, resolve symbolic refs or object IDs, fetch, inspect repository state, or determine branch
protection.

## Preview hostnames

`validateDnsLabel` accepts only 1–63 character lower-case ASCII labels made from letters, digits,
and internal hyphens. It rejects dots, wildcards, underscores, whitespace, Unicode, uppercase,
braces, and hyphen boundaries without lowercasing or IDN conversion.

`createApprovedPreviewBase` is the only supported constructor for an approved base. It creates an
immutable opaque ID/domain/labelSuffix namespace with private type and runtime identity. Base domains have
non-empty lower-case ASCII labels and a maximum textual length of 253 characters. Schemes,
credentials, ports, paths, queries, fragments, wildcards, trailing dots, and empty labels are
invalid. This constructor validates syntax; it does not claim that DNS ownership or external
configuration has been verified.

`createApprovedPreviewBaseRegistry` accepts only constructor-created bases, rejects duplicate IDs
and domains, and snapshots their immutable namespace associations into package-private state. The returned
registry is opaque and immutable: it exposes no map, array, lookup callback, selected domain, or
mutable validator. Exact base-ID matching is case-sensitive. Mutating the caller's source array
after construction cannot affect registry resolution.

`validatePreviewHostnamePattern` permits exactly one generated label and the placeholders
`{project}`, `{workspace}`, `{preview}`, and `{shortId}`. A pattern must use at least one
placeholder, must be capable of producing a valid label with minimal valid substitutions, and
may contain only lower-case ASCII label literals outside placeholders. Repeating a placeholder
is rejected. Dots, wildcard/URL syntax, literal braces, unknown or malformed placeholders,
uppercase, and Unicode are rejected.

`parseApprovedPreviewBaseRegistryJson` is the shared closed parser for `DEVSPACE_PREVIEW_BASES`.
Each entry must contain exactly `id`, `domain`, and lowercase `labelSuffix`; the suffix begins with
`-`, ends alphanumerically, contains no dots or wildcard syntax, and is part of one DNS label.
Web, Agent, and gateway configuration consume this parser rather than independently parsing
registry entries. `isApprovedPreviewHostname` accepts exactly one label above the base whose
nonempty stem ends in the configured suffix.

`composePreviewHostname` accepts only a package-created opaque registry. Project Options supplies
only the approved base ID; callers cannot provide or replace the selected domain. Composition
looks up the exact ID internally, defensively revalidates its associated domain and suffix, requires
exactly the validated values declared by the pattern, substitutes and validates the generated stem,
appends exactly that suffix label, and enforces both the 63-character leftmost-label and 253-character
hostname limits. It does not
prove DNS ownership, TLS, wildcard DNS, Cloudflare Access, Tunnel, Caddy, or route configuration
and performs none of those operations.

## Non-goals

This package does not perform filesystem access, canonicalization, repository discovery, Git
commands or ref resolution, import-root authorization, filesystem mutation, symlink-safe access,
DNS/TLS verification, gateway registration, redaction, Project Options parsing, runtime-plan
compilation, container policy validation, or runtime operations.
