import {
  validationFailure,
  validationSuccess,
  type ApprovedPreviewBaseValidationErrorCode,
  type ValidationResult
} from "./validation-result.js";

const maximumDnsNameLength = 253;

export type DnsLabelValidator = (
  input: string,
  field: string
) => ValidationResult<string>;

export function validateApprovedPreviewBaseDomain(
  domain: string,
  validateLabel: DnsLabelValidator
): ValidationResult<string> {
  const fail = (
    code: ApprovedPreviewBaseValidationErrorCode,
    details: Readonly<Record<string, string | number>> = {}
  ): ValidationResult<never> => validationFailure(
    "approved-preview-base",
    code,
    domain,
    "domain",
    "administrator-approved-preview-base",
    details
  );

  if (domain.length === 0) {
    return fail("APPROVED_BASE_EMPTY");
  }
  if (domain.length > maximumDnsNameLength) {
    return fail("APPROVED_BASE_TOO_LONG", {
      actualLength: domain.length,
      maximumLength: maximumDnsNameLength
    });
  }

  const labels = domain.split(".");
  for (const [labelIndex, label] of labels.entries()) {
    if (label.length === 0) {
      return fail("APPROVED_BASE_EMPTY_LABEL", { labelIndex });
    }
    const labelResult = validateLabel(label, `domain.labels[${labelIndex}]`);
    if (!labelResult.ok) {
      return fail("APPROVED_BASE_INVALID_LABEL", {
        labelErrorCode: labelResult.error.code,
        labelIndex
      });
    }
  }

  return validationSuccess(domain);
}
