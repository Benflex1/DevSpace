# Static analysis

## Semgrep CE foundation

DevSpace starts static-analysis CI with Semgrep Community Edition (CE) because it is a free,
accountless, repository-local scanner that can run deterministic community rules without a Semgrep
AppSec Platform account, token, paid service, source upload, or findings upload. The workflow is
separate from the long-running clean-clone verification workflow so scan status and the report are
independently visible.

The pinned official image is:

```text
semgrep/semgrep:1.171.0@sha256:bdf7013b2c3634a487671158da77c554f531742326b543a9464d2adf6c433ac8
```

The image digest is the multi-architecture manifest digest. The workflow prints the executable
version and verifies that it is `1.171.0` before scanning. The selected ruleset is the single
curated `p/default` community pack. It provides a conservative baseline for a TypeScript/Node.js
repository without stacking overlapping broad packs or adding speculative DevSpace-specific rules.

## Workflow contract

`.github/workflows/semgrep.yml` runs on:

- `pull_request`;
- pushes to `main`;
- `workflow_dispatch`.

There is no scheduled trigger. The workflow uses `pull_request`, read-only `contents: read`
permissions, no repository secrets, no Semgrep token, no login, no write permissions, and no
PR-comment automation. `semgrep scan` runs with `--metrics=off`, so this setup does not upload
source code or findings to Semgrep's hosted platform.

The existing `.gitignore` already excludes the repository's generated, cached, vendored, and
runtime-only content relevant to this scan, including `node_modules`, `.next`, build output,
coverage, Playwright results, `.devspace-local`, and caches. No broad `.semgrepignore` is needed;
tests, tooling, workflows, deployment configuration, and security-sensitive infrastructure remain
in scope.

## Enforcement and artifacts

The initial policy is monitoring-only: findings appear in the GitHub Actions job summary and do not
fail a pull request by themselves. The workflow still fails for infrastructure or scanner failures,
including failure to start Semgrep, load rules, complete the scan, produce a JSON report, parse the
report, or generate the summary. A report with Semgrep `errors` also fails the workflow.

The complete CE JSON report is uploaded as the `semgrep-results` artifact with a 14-day retention
period. JSON is the primary AI-consumable result. The artifact is published only after the
repository-owned parser confirms that a report exists and is well-formed; `if: always()` ensures a
valid report remains available when a scan or scanner-error check fails. The workflow does not use
SARIF or GitHub private-repository code-scanning features.

To make findings blocking later, first tune the ruleset and review several runs of categorized
findings. Then change the scan policy deliberately, for example by enabling Semgrep's finding
failure behavior only after the intended severity/rule set is explicitly defined. Keep scanner,
report, and summary failures blocking throughout that change.

## Summary and local use

`tooling/semgrep-summary.mjs` parses only the CE JSON fields needed for the report: `version`,
`results`, `errors`, `paths.scanned`, `check_id`, `path`, `start.line`, `extra.message`, and
`extra.severity`. It safely handles missing optional values, escapes Markdown table cells, sorts
findings deterministically by severity/path/line/rule/message, truncates messages, omits source
snippets, and caps the displayed table at 25 findings. The full JSON artifact contains the rest.

The equivalent pinned Docker scan can be run locally from the repository root:

```bash
mkdir -p .semgrep-local
docker run --rm --init \
  --volume "$PWD:/src:ro" \
  --volume "$PWD/.semgrep-local:/output" \
  --workdir /src \
  semgrep/semgrep:1.171.0@sha256:bdf7013b2c3634a487671158da77c554f531742326b543a9464d2adf6c433ac8 \
  semgrep scan \
  --config=p/default \
  --json \
  --output=/output/semgrep-results.json \
  --metrics=off
node tooling/semgrep-summary.mjs \
  --input .semgrep-local/semgrep-results.json \
  --configuration p/default \
  --scanner-version 1.171.0
rm -rf .semgrep-local
```

The summary can also be written to a file with `--output summary.md`. Do not commit the generated
report or local output. The CI image is the source of truth for the pinned scan version.

## AI triage process

Semgrep findings are evidence, not automatic truth. ChatGPT should inspect every important finding
against the pull request diff and repository context, using the complete `semgrep-results` JSON
artifact. Findings should be classified as:

- **MUST FIX** — high-confidence security or correctness issue that should be corrected on the PR;
- **SHOULD FIX** — credible quality, maintainability, or lower-risk issue worth addressing now when
  the scope is reasonable;
- **FALSE POSITIVE** — the rule does not apply after inspecting the actual code and invariants;
- **DEFER** — valid or plausible work that is outside this PR's scope and should be tracked separately.

Findings must not be blindly autofixed. AI review must inspect important findings in repository
context, explain the classification, and fix only high-confidence issues within the PR scope. A
`nosemgrep` suppression requires a concrete rationale; suppressions should be narrow, local, and
reviewed. Broad suppressions intended only to make the report empty are not acceptable.

After important findings are resolved or classified, rerun normal CI and Semgrep, perform hands-on
testing where applicable, and then merge only after review. High-confidence security or correctness
findings may become blocking after the ruleset and baseline have been tuned.

## Original local foundation scan

The original local foundation scan used Semgrep `1.171.0`, `p/default`, JSON output, and
`--metrics=off`. It scanned 316 tracked files and reported 24 findings (13 `ERROR`, 8 `WARNING`,
and 3 `MEDIUM`) plus two CE parser errors. The parser errors were caused by two existing TypeScript test-only type expressions that
Semgrep CE could not parse; the equivalent type-only imports below preserve test behavior and allow
all 316 files to be parsed:

- `apps/web/src/server/onboarding.test.ts:7` — `import()` type in a `Parameters<>` expression;
- `packages/security/src/preview-base-defense.test.ts:6` — `import()` type in a generic call.

The first-run findings were classified individually as follows:

| Findings | Location and rule | Classification | Disposition |
| ---: | --- | --- | --- |
| 3 | New `.github/workflows/semgrep.yml` mutable action references | MUST FIX | Pinned checkout, setup-node, and upload-artifact to verified full commit SHAs. |
| 12 | `e2e/primary-workspace.spec.ts` loopback `http://127.0.0.1` test-control requests | FALSE POSITIVE | The requests stay on the local E2E harness and do not transmit application data over an external network. |
| 1 | `tooling/run-e2e-server.mjs:137` loopback readiness request | FALSE POSITIVE | The request only probes the local E2E web child on loopback. |
| 1 | `e2e/primary-workspace.spec.ts:80` dynamic test-only `RegExp` | FALSE POSITIVE | The value is a locally created project ID used to assert a Playwright URL, not attacker-controlled input. |
| 1 | `tooling/check-preview-gateway-deployment.mjs:19` dynamic `RegExp` | FALSE POSITIVE | `serviceName` is selected from three fixed repository-owned Compose service names. |
| 3 | Existing `.github/workflows/ci.yml` mutable action references | DEFER | High-confidence supply-chain hardening, but outside this separate Semgrep foundation and the existing CI workflow was not restructured. |
| 3 | Existing `pnpm-workspace.yaml` dependency-policy findings | DEFER | Worth a separate pnpm policy and lockfile-compatibility review; not changed as unrelated scope. |

The original local total was therefore 24: 3 MUST FIX, 15 FALSE POSITIVE, and 6 DEFER. The three
MUST FIX findings in that scan were the new workflow's own mutable action references; those were
resolved during the foundation implementation. No broad suppressions were added.

## First real PR artifact and post-hardening baseline

The first real GitHub Actions `semgrep-results` artifact completed successfully before this
hardening fix. It reported 21 findings, 0 scanner errors, and 316 scanned files. Its independently
reviewed disposition was:

| Findings | Classification | Disposition |
| ---: | --- | --- |
| 3 | MUST FIX | Existing `.github/workflows/ci.yml` action references were promoted from DEFER and are pinned in this change. |
| 15 | FALSE POSITIVE | Loopback-only E2E/test-server HTTP requests and the two fixed-input regular expressions remain unchanged. |
| 3 | DEFER | `blockExoticSubdeps`, `minimumReleaseAge`, and `trustPolicy` remain deferred for a separate pnpm policy/compatibility review. |

The expected and resulting post-hardening baseline is 18 findings with 0 unaddressed MUST FIX
findings: 15 FALSE POSITIVE and 3 DEFER. The three deferred pnpm policy findings are intentionally
not enabled here because they may change dependency installation and lockfile behavior.

## Limitations and future evaluation

Semgrep CE is a rule-based static scanner. It can miss runtime behavior, framework-specific data
flows, configuration interactions, generated code problems, and issues outside the selected
community pack. A finding can also be noisy or require domain context. This foundation does not
add dependency scanning, secret scanning, custom rules, automatic AI calls, automatic code changes,
PR comments, or scheduled scans.

Later M1 hardening will evaluate additional free options, without claiming adoption now:

- self-hosted SonarQube Community;
- CodeScene through eligible GitHub Student benefits;
- any GitHub Student Pack security tooling that is genuinely free for this private repository.
