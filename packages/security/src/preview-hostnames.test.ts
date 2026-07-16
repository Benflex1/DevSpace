import { describe, expect, test } from "vitest";
import {
  composePreviewHostname,
  createApprovedPreviewBase,
  createApprovedPreviewBaseRegistry,
  validateDnsLabel,
  validatePreviewHostnamePattern,
  type ApprovedPreviewBase,
  type ApprovedPreviewBaseRegistry,
  type DnsLabel,
  type PreviewHostnamePattern
} from "./index.js";

function label(input: string): DnsLabel {
  const result = validateDnsLabel(input);
  if (!result.ok) {
    throw new Error(`invalid label fixture: ${input}`);
  }
  return result.value;
}

function pattern(input: string): PreviewHostnamePattern {
  const result = validatePreviewHostnamePattern(input);
  if (!result.ok) {
    throw new Error(`invalid pattern fixture: ${input}`);
  }
  return result.value;
}

function base(id: string, domain: string): ApprovedPreviewBase {
  const result = createApprovedPreviewBase(id, domain);
  if (!result.ok) {
    throw new Error(`invalid base fixture: ${domain}`);
  }
  return result.value;
}

function registry(approvedBases: readonly ApprovedPreviewBase[]): ApprovedPreviewBaseRegistry {
  const result = createApprovedPreviewBaseRegistry(approvedBases);
  if (!result.ok) {
    throw new Error("invalid approved-base registry fixture");
  }
  return result.value;
}

function reflectClone(source: object, changedId: string): object {
  const clone = Object.create(null) as object;
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined) {
      continue;
    }
    const clonedDescriptor = { ...descriptor };
    if (key === "id") {
      clonedDescriptor.value = changedId;
    }
    Object.defineProperty(clone, key, clonedDescriptor);
  }
  return clone;
}

describe("lower-case ASCII DNS labels", () => {
  test.each(["a", "0", "preview", "preview-1", "a".repeat(63)])(
    "accepts boundary-valid label %j",
    (input) => expect(validateDnsLabel(input)).toEqual({ ok: true, value: input })
  );

  test.each([
    ["", "DNS_LABEL_EMPTY"],
    ["a".repeat(64), "DNS_LABEL_TOO_LONG"],
    ["-preview", "DNS_LABEL_HYPHEN_BOUNDARY"],
    ["preview-", "DNS_LABEL_HYPHEN_BOUNDARY"],
    ["-", "DNS_LABEL_HYPHEN_BOUNDARY"],
    ["Preview", "DNS_LABEL_INVALID_CHARACTER"],
    ["prév", "DNS_LABEL_INVALID_CHARACTER"],
    ["preview.app", "DNS_LABEL_INVALID_CHARACTER"],
    ["*.preview", "DNS_LABEL_INVALID_CHARACTER"],
    ["preview_app", "DNS_LABEL_INVALID_CHARACTER"],
    ["preview app", "DNS_LABEL_INVALID_CHARACTER"],
    ["{preview}", "DNS_LABEL_INVALID_CHARACTER"]
  ])("rejects invalid label %j without normalization", (input, code) => {
    const result = validateDnsLabel(input);
    expect(result).toMatchObject({ ok: false, error: { category: "dns-label", code, input } });
  });
});

describe("administrator-approved preview bases", () => {
  test.each([
    "preview.example.com",
    "dev.example",
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`
  ])("accepts valid base %j", (domain) => {
    const result = createApprovedPreviewBase("primary", domain);
    expect(result).toMatchObject({ ok: true, value: { id: "primary", domain } });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Reflect.set(result.value, "domain", "other.example.com")).toBe(false);
    }
  });

  test.each([
    ["", "preview.example.com", "APPROVED_BASE_ID_EMPTY"],
    ["primary", "", "APPROVED_BASE_EMPTY"],
    ["primary", `a.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(61)}`, "APPROVED_BASE_TOO_LONG"],
    ["primary", "preview..example.com", "APPROVED_BASE_EMPTY_LABEL"],
    ["primary", "preview.example.com.", "APPROVED_BASE_EMPTY_LABEL"],
    ["primary", "*.example.com", "APPROVED_BASE_INVALID_LABEL"],
    ["primary", "Preview.example.com", "APPROVED_BASE_INVALID_LABEL"],
    ["primary", "preview_app.example.com", "APPROVED_BASE_INVALID_LABEL"],
    ["primary", "https://preview.example.com", "APPROVED_BASE_INVALID_LABEL"],
    ["primary", "preview.example.com/path", "APPROVED_BASE_INVALID_LABEL"],
    ["primary", "preview.example.com?query", "APPROVED_BASE_INVALID_LABEL"],
    ["primary", "preview.example.com#fragment", "APPROVED_BASE_INVALID_LABEL"],
    ["primary", "preview.example.com:443", "APPROVED_BASE_INVALID_LABEL"],
    ["primary", "user@preview.example.com", "APPROVED_BASE_INVALID_LABEL"],
    ["primary", " preview.example.com", "APPROVED_BASE_INVALID_LABEL"],
    ["primary", "prév.example.com", "APPROVED_BASE_INVALID_LABEL"]
  ])("rejects invalid approved base id/domain", (id, domain, code) => {
    expect(createApprovedPreviewBase(id, domain)).toMatchObject({
      ok: false,
      error: { category: "approved-preview-base", code }
    });
  });
});

describe("one-label preview patterns", () => {
  test.each([
    "{project}-{workspace}-{preview}",
    "{workspace}-{preview}",
    "{project}-{shortId}"
  ])("accepts %j", (input) => {
    expect(validatePreviewHostnamePattern(input)).toEqual({ ok: true, value: input });
  });

  test.each([
    ["", "PREVIEW_PATTERN_EMPTY"],
    ["{unknown}", "PREVIEW_PATTERN_UNKNOWN_PLACEHOLDER"],
    ["{project}.{workspace}", "PREVIEW_PATTERN_MULTIPLE_LABELS"],
    ["*.preview", "PREVIEW_PATTERN_MULTIPLE_LABELS"],
    ["{project", "PREVIEW_PATTERN_MALFORMED_PLACEHOLDER"],
    ["project}", "PREVIEW_PATTERN_MALFORMED_PLACEHOLDER"],
    ["{{project}}", "PREVIEW_PATTERN_MALFORMED_PLACEHOLDER"],
    ["{}", "PREVIEW_PATTERN_MALFORMED_PLACEHOLDER"],
    ["{PROJECT}", "PREVIEW_PATTERN_UNKNOWN_PLACEHOLDER"],
    ["{project}_{preview}", "PREVIEW_PATTERN_INVALID_CHARACTER"],
    ["https://{project}", "PREVIEW_PATTERN_INVALID_CHARACTER"],
    ["{project}:{preview}", "PREVIEW_PATTERN_INVALID_CHARACTER"],
    ["\\{project}", "PREVIEW_PATTERN_INVALID_CHARACTER"],
    ["literal-only", "PREVIEW_PATTERN_PLACEHOLDER_REQUIRED"],
    ["Preview-{project}", "PREVIEW_PATTERN_INVALID_CHARACTER"],
    ["prév-{project}", "PREVIEW_PATTERN_INVALID_CHARACTER"],
    ["{project}-{project}", "PREVIEW_PATTERN_REPEATED_PLACEHOLDER"],
    ["-{project}", "PREVIEW_PATTERN_CANNOT_FORM_LABEL"],
    ["{project}-", "PREVIEW_PATTERN_CANNOT_FORM_LABEL"],
    [`${"a".repeat(63)}{project}`, "PREVIEW_PATTERN_CANNOT_FORM_LABEL"]
  ])("rejects malicious or impossible pattern %j", (input, code) => {
    expect(validatePreviewHostnamePattern(input)).toMatchObject({
      ok: false,
      error: { category: "preview-pattern", code, input }
    });
  });
});

describe("approved-base preview hostname composition", () => {
  const primaryBase = base("primary", "preview.example.com");
  const secondaryBase = base("secondary", "other.example.com");
  const approvedBases = registry([primaryBase, secondaryBase]);

  test.each([
    ["{project}-{workspace}-{preview}", "devspace-primary-web"],
    ["{workspace}-{preview}", "primary-web"],
    ["{project}-{shortId}", "devspace-a1b2"]
  ])("composes %j as exactly one label on the approved base", (rawPattern, generated) => {
    const withAllValues = composePreviewHostname(
      pattern(rawPattern),
      {
        project: label("devspace"),
        workspace: label("primary"),
        preview: label("web"),
        shortId: label("a1b2")
      },
      "primary",
      approvedBases
    );
    expect(withAllValues).toMatchObject({
      ok: false,
      error: { code: "PREVIEW_PLACEHOLDER_UNDECLARED" }
    });

    const usedValues = rawPattern === "{project}-{workspace}-{preview}"
      ? { project: label("devspace"), workspace: label("primary"), preview: label("web") }
      : rawPattern === "{workspace}-{preview}"
        ? { workspace: label("primary"), preview: label("web") }
        : { project: label("devspace"), shortId: label("a1b2") };
    expect(composePreviewHostname(pattern(rawPattern), usedValues, "primary", approvedBases))
      .toEqual({ ok: true, value: `${generated}.preview.example.com` });
  });

  test("rejects an unknown approved base ID", () => {
    expect(composePreviewHostname(
      pattern("{project}-{shortId}"),
      { project: label("devspace"), shortId: label("a1b2") },
      "unknown",
      approvedBases
    )).toMatchObject({ ok: false, error: { code: "PREVIEW_BASE_UNKNOWN" } });
  });

  test("revalidates a forged runtime pattern brand", () => {
    expect(composePreviewHostname(
      "{unknown}" as PreviewHostnamePattern,
      {},
      "primary",
      approvedBases
    )).toMatchObject({
      ok: false,
      error: { category: "preview-pattern", code: "PREVIEW_PATTERN_UNKNOWN_PLACEHOLDER" }
    });
  });

  test("binds each requested ID to only its registered domain", () => {
    const values = { project: label("demo") };
    expect(composePreviewHostname(pattern("{project}"), values, "primary", approvedBases))
      .toEqual({ ok: true, value: "demo.preview.example.com" });
    expect(composePreviewHostname(pattern("{project}"), values, "secondary", approvedBases))
      .toEqual({ ok: true, value: "demo.other.example.com" });
  });

  test("rejects a cross-mixed structural approved base at registry construction", () => {
    const mixed = { id: primaryBase.id, domain: secondaryBase.domain };
    expect(createApprovedPreviewBaseRegistry([
      mixed as unknown as ApprovedPreviewBase
    ])).toMatchObject({
      ok: false,
      error: { code: "APPROVED_BASE_REGISTRY_INVALID_BASE" }
    });
  });

  test("rejects a structurally forged registry or replaceable lookup", () => {
    const forgedRegistry = { get: () => primaryBase };
    expect(composePreviewHostname(
      pattern("{project}"),
      { project: label("devspace") },
      "primary",
      forgedRegistry as unknown as ApprovedPreviewBaseRegistry
    )).toMatchObject({ ok: false, error: { code: "PREVIEW_BASE_REGISTRY_INVALID" } });
  });

  test("never accepts a malformed domain from a structural lookup value", () => {
    const forgedRegistry = {
      get: () => ({ id: "primary", domain: "evil.example/path" })
    };
    const result = composePreviewHostname(
      pattern("{project}"),
      { project: label("demo") },
      "primary",
      forgedRegistry as unknown as ApprovedPreviewBaseRegistry
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "PREVIEW_BASE_REGISTRY_INVALID" }
    });
    expect(result).not.toMatchObject({ ok: true, value: "demo.evil.example/path" });
  });

  test("rejects missing and undeclared placeholder inputs", () => {
    expect(composePreviewHostname(
      pattern("{project}-{shortId}"),
      { project: label("devspace") },
      "primary",
      approvedBases
    )).toMatchObject({ ok: false, error: { code: "PREVIEW_PLACEHOLDER_MISSING" } });

    expect(composePreviewHostname(
      pattern("{project}"),
      { project: label("devspace"), preview: label("web") },
      "primary",
      approvedBases
    )).toMatchObject({ ok: false, error: { code: "PREVIEW_PLACEHOLDER_UNDECLARED" } });
  });

  test("rejects a substitution producing an overlong label", () => {
    expect(composePreviewHostname(
      pattern("{project}-{preview}"),
      { project: label("a".repeat(63)), preview: label("b") },
      "primary",
      approvedBases
    )).toMatchObject({
      ok: false,
      error: {
        code: "PREVIEW_GENERATED_LABEL_INVALID",
        details: { labelErrorCode: "DNS_LABEL_TOO_LONG" }
      }
    });
  });

  test("accepts a 253-character FQDN and rejects 254 characters", () => {
    const exactBase = base("exact", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(59)}`);
    const overBase = base("over", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}`);
    const bases = registry([exactBase, overBase]);
    expect(composePreviewHostname(pattern("{shortId}"), { shortId: label("x") }, "exact", bases))
      .toMatchObject({ ok: true });
    expect(composePreviewHostname(pattern("{shortId}"), { shortId: label("x") }, "over", bases))
      .toMatchObject({ ok: false, error: { code: "PREVIEW_HOSTNAME_TOO_LONG" } });
  });
});

describe("opaque approved-base registries", () => {
  test("rejects a fully reflected copied-symbol approved-base forgery", () => {
    const source = base("source", "source.example.com");
    const other = base("other", "other.example.com");
    const forged = reflectClone(source, other.id);

    expect(Reflect.ownKeys(forged)).toEqual(Reflect.ownKeys(source));
    for (const key of Reflect.ownKeys(source)) {
      if (key !== "id") {
        expect(Object.getOwnPropertyDescriptor(forged, key)).toEqual(
          Object.getOwnPropertyDescriptor(source, key)
        );
      }
    }
    expect((forged as { readonly id: string }).id).toBe(other.id);
    expect((forged as { readonly domain: string }).domain).toBe(source.domain);

    expect(createApprovedPreviewBaseRegistry([
      forged as unknown as ApprovedPreviewBase
    ])).toMatchObject({
      ok: false,
      error: { code: "APPROVED_BASE_REGISTRY_INVALID_BASE" }
    });
  });

  test.each([
    new Map<string, ApprovedPreviewBase>(),
    { primary: base("primary", "preview.example.com") },
    { get: () => undefined }
  ])("rejects a raw map, dictionary, or callback source", (source) => {
    expect(createApprovedPreviewBaseRegistry(
      source as unknown as readonly ApprovedPreviewBase[]
    )).toMatchObject({
      ok: false,
      error: { code: "APPROVED_BASE_REGISTRY_INVALID_SOURCE" }
    });
  });

  test("rejects duplicate IDs deterministically", () => {
    const first = base("duplicate", "first.example.com");
    const second = base("duplicate", "second.example.com");
    const expected = {
      ok: false,
      error: {
        category: "approved-preview-base",
        code: "APPROVED_BASE_DUPLICATE_ID",
        input: "duplicate",
        field: "approvedBases[1].id",
        policy: "opaque-approved-preview-base-registry",
        details: { baseId: "duplicate", duplicateIndex: 1, firstIndex: 0 }
      }
    };
    expect(createApprovedPreviewBaseRegistry([first, second])).toEqual(expected);
    expect(createApprovedPreviewBaseRegistry([first, second])).toEqual(expected);
  });

  test("matches IDs exactly and case-sensitively", () => {
    const upper = base("Primary", "upper.example.com");
    const lower = base("primary", "lower.example.com");
    const bases = registry([upper, lower]);
    const values = { project: label("demo") };
    expect(composePreviewHostname(pattern("{project}"), values, "Primary", bases))
      .toEqual({ ok: true, value: "demo.upper.example.com" });
    expect(composePreviewHostname(pattern("{project}"), values, "primary", bases))
      .toEqual({ ok: true, value: "demo.lower.example.com" });
    expect(composePreviewHostname(pattern("{project}"), values, "PRIMARY", bases))
      .toMatchObject({ ok: false, error: { code: "PREVIEW_BASE_UNKNOWN" } });
  });

  test("snapshots the source array and keeps registry state opaque and immutable", () => {
    const original = base("original", "original.example.com");
    const later = base("later", "later.example.com");
    const source: ApprovedPreviewBase[] = [original];
    const bases = registry(source);
    source[0] = later;
    source.push(later);

    expect(Object.isFrozen(bases)).toBe(true);
    expect(Object.keys(bases)).toEqual([]);
    expect(Reflect.set(bases, "get", () => later)).toBe(false);
    const privateSymbols = Object.getOwnPropertySymbols(bases);
    expect(privateSymbols).toHaveLength(1);
    const copiedBrandOnly = { [privateSymbols[0] as symbol]: true };
    expect(composePreviewHostname(
      pattern("{project}"),
      { project: label("demo") },
      "original",
      copiedBrandOnly as unknown as ApprovedPreviewBaseRegistry
    )).toMatchObject({ ok: false, error: { code: "PREVIEW_BASE_REGISTRY_INVALID" } });
    expect(composePreviewHostname(
      pattern("{project}"),
      { project: label("demo") },
      "original",
      bases
    )).toEqual({ ok: true, value: "demo.original.example.com" });
    expect(composePreviewHostname(
      pattern("{project}"),
      { project: label("demo") },
      "later",
      bases
    )).toMatchObject({ ok: false, error: { code: "PREVIEW_BASE_UNKNOWN" } });
  });

  test("source approved bases resist mutation without changing registry resolution", () => {
    const original = base("original", "original.example.com");
    const bases = registry([original]);
    expect(Reflect.set(original, "domain", "mutated.example.com")).toBe(false);
    expect(Reflect.set(original, "id", "mutated")).toBe(false);
    expect(composePreviewHostname(
      pattern("{project}"),
      { project: label("demo") },
      "original",
      bases
    )).toEqual({ ok: true, value: "demo.original.example.com" });
  });
});
