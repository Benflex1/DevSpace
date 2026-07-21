import { beforeEach, expect, test, vi } from "vitest";

const domainValidationProbe = vi.hoisted(() => ({ calls: 0, failOnCall: 3 }));

vi.mock("./preview-base-domain.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./preview-base-domain.js")>();
  return {
    ...original,
    validateApprovedPreviewBaseDomain: (
      ...arguments_: Parameters<typeof original.validateApprovedPreviewBaseDomain>
    ) => {
      domainValidationProbe.calls += 1;
      if (domainValidationProbe.calls === domainValidationProbe.failOnCall) {
        return original.validateApprovedPreviewBaseDomain("evil.example/path", arguments_[1]);
      }
      return original.validateApprovedPreviewBaseDomain(...arguments_);
    }
  };
});

import {
  composePreviewHostname,
  createApprovedPreviewBase,
  createApprovedPreviewBaseRegistry,
  validateDnsLabel,
  validatePreviewHostnamePattern
} from "./index.js";

beforeEach(() => {
  domainValidationProbe.calls = 0;
  domainValidationProbe.failOnCall = 3;
});

test("composition defensively revalidates the internally selected approved-base domain", () => {
  const approvedBase = createApprovedPreviewBase("primary", "preview.example.com", "-preview");
  expect(approvedBase.ok).toBe(true);
  if (!approvedBase.ok) return;

  const registry = createApprovedPreviewBaseRegistry([approvedBase.value]);
  expect(registry.ok).toBe(true);
  if (!registry.ok) return;

  const pattern = validatePreviewHostnamePattern("{project}");
  const project = validateDnsLabel("demo");
  expect(pattern.ok && project.ok).toBe(true);
  if (!pattern.ok || !project.ok) return;

  expect(composePreviewHostname(
    pattern.value,
    { project: project.value },
    "primary",
    registry.value
  )).toMatchObject({
    ok: false,
    error: {
      code: "PREVIEW_BASE_DOMAIN_INVALID",
      input: "preview.example.com",
      details: {
        baseId: "primary",
        domainErrorCode: "APPROVED_BASE_INVALID_LABEL"
      }
    }
  });
  expect(domainValidationProbe.calls).toBe(3);
});
