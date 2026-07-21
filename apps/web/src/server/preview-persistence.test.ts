import { createApprovedPreviewBase, createApprovedPreviewBaseRegistry } from "@devspace/security";
import { parseProjectOptionsV1 } from "@devspace/project-options";
import { describe, expect, test } from "vitest";
import { materializePreview } from "./preview-persistence.js";

const base = createApprovedPreviewBase("preview-main", "preview.example.com", "-preview");
if (!base.ok) throw new Error("invalid preview base fixture");
const registry = createApprovedPreviewBaseRegistry([base.value]);
if (!registry.ok) throw new Error("invalid preview registry fixture");

describe("Web preview persistence", () => {
  test("materializes the deterministic hostname before route readiness", () => {
    const options = parseProjectOptionsV1({
      schemaVersion: 1,
      developmentEnvironment: {
        source: { kind: "image", imageReference: "node:24" },
        ports: [{ name: "web", containerPort: 3000 }]
      },
      previews: [{
        key: "web", displayName: "Web", target: { kind: "workspace" }, containerPort: 3000,
        domainBaseId: "preview-main", hostnamePattern: "{project}-{workspace}-{preview}-{shortId}"
      }]
    });
    const row = materializePreview({
      id: "0190a000-0000-7000-8000-000000000001",
      projectId: "0190a000-0000-7000-8000-000000000002",
      projectSlug: "alpha",
      workspaceId: "0190a000-0000-7000-8000-000000000003",
      workspaceSlug: "primary",
      configRevisionId: "0190a000-0000-7000-8000-000000000004",
      preview: options.previews[0]!,
      previewBaseRegistry: registry.value,
      now: "2026-07-16T12:00:00.000Z"
    });
    expect(row.hostname).toBe("alpha-primary-web-0190a000-preview.preview.example.com");
    expect(row.routePresent).toBe(false);
    expect(row.serviceId).toBeNull();
    expect(row.containerPort).toBe(3000);
  });
});
