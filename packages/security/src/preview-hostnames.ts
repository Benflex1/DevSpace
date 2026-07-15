import {
  validationFailure,
  validationSuccess,
  type ApprovedPreviewBaseValidationErrorCode,
  type DnsLabelValidationErrorCode,
  type PreviewCompositionValidationErrorCode,
  type PreviewPatternValidationErrorCode,
  type ValidationResult
} from "./validation-result.js";
import { validateApprovedPreviewBaseDomain } from "./preview-base-domain.js";

const maximumDnsLabelLength = 63;
const maximumDnsNameLength = 253;

const previewPlaceholderNames = Object.freeze([
  "project",
  "workspace",
  "preview",
  "shortId"
] as const);

export type PreviewPlaceholderName = (typeof previewPlaceholderNames)[number];

declare const dnsLabelBrand: unique symbol;
declare const previewHostnamePatternBrand: unique symbol;
declare const previewHostnameBrand: unique symbol;

const approvedPreviewBaseBrand = Symbol("ApprovedPreviewBase");
const approvedPreviewBaseRegistryBrand = Symbol("ApprovedPreviewBaseRegistry");

export type DnsLabel = string & { readonly [dnsLabelBrand]: true };
export type PreviewHostnamePattern = string & { readonly [previewHostnamePatternBrand]: true };
export type PreviewHostname = string & { readonly [previewHostnameBrand]: true };

export type ApprovedPreviewBase = Readonly<{
  readonly id: string;
  readonly domain: string;
  readonly [approvedPreviewBaseBrand]: true;
}>;

export type ApprovedPreviewBaseRegistry = Readonly<{
  readonly [approvedPreviewBaseRegistryBrand]: true;
}>;

export type PreviewPlaceholderValues = Readonly<Partial<Record<PreviewPlaceholderName, DnsLabel>>>;

interface ApprovedPreviewBaseRecord {
  readonly id: string;
  readonly domain: string;
}

const approvedPreviewBaseRecords = new WeakMap<object, ApprovedPreviewBaseRecord>();
const approvedPreviewBaseRegistryRecords = new WeakMap<
  object,
  readonly ApprovedPreviewBaseRecord[]
>();

function dnsLabelFailure(
  input: string,
  field: string,
  code: DnsLabelValidationErrorCode,
  details: Readonly<Record<string, string | number>> = {}
): ValidationResult<never> {
  return validationFailure("dns-label", code, input, field, "lowercase-ascii-dns-label", details);
}

export function validateDnsLabel(input: string, field = "label"): ValidationResult<DnsLabel> {
  if (input.length === 0) {
    return dnsLabelFailure(input, field, "DNS_LABEL_EMPTY");
  }
  if (input.length > maximumDnsLabelLength) {
    return dnsLabelFailure(input, field, "DNS_LABEL_TOO_LONG", {
      actualLength: input.length,
      maximumLength: maximumDnsLabelLength
    });
  }
  if (!/^[a-z0-9-]+$/.test(input)) {
    return dnsLabelFailure(input, field, "DNS_LABEL_INVALID_CHARACTER");
  }
  if (!/^[a-z0-9].*[a-z0-9]$/.test(input) && input.length > 1) {
    return dnsLabelFailure(input, field, "DNS_LABEL_HYPHEN_BOUNDARY");
  }
  if (input === "-") {
    return dnsLabelFailure(input, field, "DNS_LABEL_HYPHEN_BOUNDARY");
  }
  return validationSuccess(input as DnsLabel);
}

export function createApprovedPreviewBase(
  id: string,
  domain: string
): ValidationResult<ApprovedPreviewBase> {
  const fail = (
    code: ApprovedPreviewBaseValidationErrorCode,
    field: string,
    input: string,
    details: Readonly<Record<string, string | number>> = {}
  ): ValidationResult<never> => validationFailure(
    "approved-preview-base",
    code,
    input,
    field,
    "administrator-approved-preview-base",
    details
  );

  if (id.length === 0) {
    return fail("APPROVED_BASE_ID_EMPTY", "domainBaseId", id);
  }
  const domainResult = validateApprovedPreviewBaseDomain(domain, validateDnsLabel);
  if (!domainResult.ok) {
    return domainResult;
  }

  const record = Object.freeze({ id, domain: domainResult.value });
  const approvedBase = Object.freeze({
    id: record.id,
    domain: record.domain,
    [approvedPreviewBaseBrand]: true as const
  });
  approvedPreviewBaseRecords.set(approvedBase, record);
  return validationSuccess(approvedBase);
}

export function createApprovedPreviewBaseRegistry(
  approvedBases: readonly ApprovedPreviewBase[]
): ValidationResult<ApprovedPreviewBaseRegistry> {
  const sourceValues: readonly unknown[] = approvedBases;
  if (!Array.isArray(sourceValues)) {
    return validationFailure(
      "approved-preview-base",
      "APPROVED_BASE_REGISTRY_INVALID_SOURCE",
      "[unsupported approved base registry source]",
      "approvedBases",
      "opaque-approved-preview-base-registry"
    );
  }

  const records: ApprovedPreviewBaseRecord[] = [];
  const firstIndexById = new Map<string, number>();

  for (let baseIndex = 0; baseIndex < sourceValues.length; baseIndex += 1) {
    const approvedBase: unknown = sourceValues[baseIndex];
    const sourceRecord = typeof approvedBase === "object" && approvedBase !== null
      ? approvedPreviewBaseRecords.get(approvedBase)
      : undefined;
    if (sourceRecord === undefined) {
      return validationFailure(
        "approved-preview-base",
        "APPROVED_BASE_REGISTRY_INVALID_BASE",
        "[unrecognized approved base]",
        `approvedBases[${baseIndex}]`,
        "opaque-approved-preview-base-registry",
        { baseIndex }
      );
    }

    const domainResult = validateApprovedPreviewBaseDomain(sourceRecord.domain, validateDnsLabel);
    if (!domainResult.ok) {
      return validationFailure(
        "approved-preview-base",
        "APPROVED_BASE_REGISTRY_INVALID_BASE",
        sourceRecord.domain,
        `approvedBases[${baseIndex}].domain`,
        "opaque-approved-preview-base-registry",
        { baseIndex, domainErrorCode: domainResult.error.code }
      );
    }

    const firstIndex = firstIndexById.get(sourceRecord.id);
    if (firstIndex !== undefined) {
      return validationFailure(
        "approved-preview-base",
        "APPROVED_BASE_DUPLICATE_ID",
        sourceRecord.id,
        `approvedBases[${baseIndex}].id`,
        "opaque-approved-preview-base-registry",
        { baseId: sourceRecord.id, duplicateIndex: baseIndex, firstIndex }
      );
    }

    firstIndexById.set(sourceRecord.id, baseIndex);
    records.push(Object.freeze({ id: sourceRecord.id, domain: domainResult.value }));
  }

  const registry = Object.freeze({ [approvedPreviewBaseRegistryBrand]: true as const });
  approvedPreviewBaseRegistryRecords.set(registry, Object.freeze(records));
  return validationSuccess(registry);
}

function parsePreviewPattern(
  input: string
): ValidationResult<readonly PreviewPlaceholderName[]> {
  const fail = (
    code: PreviewPatternValidationErrorCode,
    details: Readonly<Record<string, string | number | readonly string[]>> = {}
  ): ValidationResult<never> => validationFailure(
    "preview-pattern",
    code,
    input,
    "hostnamePattern",
    "one-label-preview-pattern",
    details
  );

  if (input.length === 0) {
    return fail("PREVIEW_PATTERN_EMPTY");
  }
  if (input.includes(".")) {
    return fail("PREVIEW_PATTERN_MULTIPLE_LABELS");
  }

  const used: PreviewPlaceholderName[] = [];
  let minimalLabel = "";
  let cursor = 0;
  while (cursor < input.length) {
    const character = input[cursor];
    if (character === "{") {
      const closingBrace = input.indexOf("}", cursor + 1);
      if (closingBrace === -1) {
        return fail("PREVIEW_PATTERN_MALFORMED_PLACEHOLDER", { offset: cursor });
      }
      const placeholder = input.slice(cursor + 1, closingBrace);
      if (placeholder.includes("{") || placeholder.length === 0) {
        return fail("PREVIEW_PATTERN_MALFORMED_PLACEHOLDER", { offset: cursor });
      }
      if (!(previewPlaceholderNames as readonly string[]).includes(placeholder)) {
        return fail("PREVIEW_PATTERN_UNKNOWN_PLACEHOLDER", { placeholder });
      }
      const name = placeholder as PreviewPlaceholderName;
      if (used.includes(name)) {
        return fail("PREVIEW_PATTERN_REPEATED_PLACEHOLDER", { placeholder });
      }
      used.push(name);
      minimalLabel += "a";
      cursor = closingBrace + 1;
      continue;
    }
    if (character === "}") {
      return fail("PREVIEW_PATTERN_MALFORMED_PLACEHOLDER", { offset: cursor });
    }
    if (character === undefined || !/[a-z0-9-]/.test(character)) {
      return fail("PREVIEW_PATTERN_INVALID_CHARACTER", { offset: cursor });
    }
    minimalLabel += character;
    cursor += 1;
  }

  if (used.length === 0) {
    return fail("PREVIEW_PATTERN_PLACEHOLDER_REQUIRED");
  }
  if (!validateDnsLabel(minimalLabel).ok) {
    return fail("PREVIEW_PATTERN_CANNOT_FORM_LABEL", { minimalLength: minimalLabel.length });
  }
  return validationSuccess(Object.freeze([...used]));
}

export function validatePreviewHostnamePattern(
  input: string
): ValidationResult<PreviewHostnamePattern> {
  const result = parsePreviewPattern(input);
  return result.ok
    ? validationSuccess(input as PreviewHostnamePattern)
    : result;
}

export function composePreviewHostname(
  pattern: PreviewHostnamePattern,
  values: PreviewPlaceholderValues,
  requestedBaseId: string,
  registry: ApprovedPreviewBaseRegistry
): ValidationResult<PreviewHostname> {
  const fail = (
    code: PreviewCompositionValidationErrorCode,
    input: string,
    field: string,
    details: Readonly<Record<string, string | number | readonly string[]>> = {}
  ): ValidationResult<never> => validationFailure(
    "preview-composition",
    code,
    input,
    field,
    "approved-base-preview-hostname-composition",
    details
  );

  const records = typeof registry === "object" && registry !== null
    ? approvedPreviewBaseRegistryRecords.get(registry)
    : undefined;
  if (records === undefined) {
    return fail(
      "PREVIEW_BASE_REGISTRY_INVALID",
      "[unrecognized approved base registry]",
      "approvedBaseRegistry"
    );
  }

  const base = records.find((candidate) => candidate.id === requestedBaseId);
  if (base === undefined) {
    return fail("PREVIEW_BASE_UNKNOWN", requestedBaseId, "domainBaseId");
  }

  const domainResult = validateApprovedPreviewBaseDomain(base.domain, validateDnsLabel);
  if (!domainResult.ok) {
    return fail("PREVIEW_BASE_DOMAIN_INVALID", base.domain, "approvedBase.domain", {
      baseId: requestedBaseId,
      domainErrorCode: domainResult.error.code
    });
  }

  const parsed = parsePreviewPattern(pattern);
  if (!parsed.ok) {
    return parsed;
  }
  const used = parsed.value;
  for (const placeholder of used) {
    if (values[placeholder] === undefined) {
      return fail("PREVIEW_PLACEHOLDER_MISSING", pattern, `values.${placeholder}`, { placeholder });
    }
  }
  const supplied = Object.keys(values) as PreviewPlaceholderName[];
  const undeclared = supplied.filter((placeholder) => !used.includes(placeholder));
  if (undeclared.length > 0) {
    return fail("PREVIEW_PLACEHOLDER_UNDECLARED", pattern, "values", {
      placeholders: Object.freeze([...undeclared])
    });
  }

  const generatedLabel = pattern.replace(/\{(project|workspace|preview|shortId)\}/g, (_, name: string) => (
    values[name as PreviewPlaceholderName] ?? ""
  ));
  const labelResult = validateDnsLabel(generatedLabel, "generatedPreviewLabel");
  if (!labelResult.ok) {
    return fail("PREVIEW_GENERATED_LABEL_INVALID", generatedLabel, "generatedPreviewLabel", {
      labelErrorCode: labelResult.error.code
    });
  }

  const hostname = `${labelResult.value}.${domainResult.value}`;
  if (hostname.length > maximumDnsNameLength) {
    return fail("PREVIEW_HOSTNAME_TOO_LONG", hostname, "previewHostname", {
      actualLength: hostname.length,
      maximumLength: maximumDnsNameLength
    });
  }
  return validationSuccess(hostname as PreviewHostname);
}
