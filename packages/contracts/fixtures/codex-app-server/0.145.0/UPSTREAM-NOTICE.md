# Codex app-server generated fixture provenance

The JSON files in this directory were generated, without manual edits, by the OpenAI Codex CLI:

```text
codex-cli 0.145.0
CLI binary SHA-256:
a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14
```

Stable-default components were generated with:

```text
codex app-server generate-json-schema --out <directory>
```

The separately classified structured-input component was generated with:

```text
codex app-server generate-json-schema --experimental --out <directory>
```

Generation occurred on 2026-07-26. `protocol-manifest.json` records the byte length and SHA-256 of
every checked component. Tests read, hash, parse, and inspect those files without network access.

Upstream source: <https://github.com/openai/codex>

Upstream app-server documentation:
<https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>

OpenAI Codex is licensed under Apache-2.0:
<https://github.com/openai/codex/blob/main/LICENSE>
