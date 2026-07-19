import {
  composePreviewHostname,
  validateDnsLabel,
  validatePreviewHostnamePattern,
  type ApprovedPreviewBaseRegistry,
  type DnsLabel
} from "@devspace/security";
import type { NewPreview } from "@devspace/database";
import type { ProjectOptionsV1 } from "@devspace/project-options";

export class PreviewMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewMaterializationError";
  }
}

export interface PreviewMaterializationInput {
  readonly id: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly configRevisionId: string;
  readonly preview: ProjectOptionsV1["previews"][number];
  readonly previewServiceId?: string;
  readonly previewBaseRegistry: ApprovedPreviewBaseRegistry;
  readonly now: string;
}

function label(value: string, field: string): DnsLabel {
  const result = validateDnsLabel(value, field);
  if (!result.ok) throw new PreviewMaterializationError(`${field} is not a valid DNS label.`);
  return result.value;
}

function pattern(value: string) {
  const result = validatePreviewHostnamePattern(value);
  if (!result.ok) throw new PreviewMaterializationError(`Preview hostname pattern is invalid: ${result.error.code}.`);
  return result.value;
}

/**
 * Converts one immutable Project Options preview into the Web-owned durable row.
 * This function deliberately has no runtime, Docker, gateway, or lease side effects.
 */
export function materializePreview(input: PreviewMaterializationInput): NewPreview {
  const { preview } = input;
  const hostnameResult = composePreviewHostname(
    pattern(preview.hostnamePattern),
    {
      project: label(input.projectSlug, "projectSlug"),
      workspace: label(input.workspaceSlug, "workspaceSlug"),
      preview: label(preview.key, "previewKey"),
      shortId: label(input.id.slice(0, 8), "previewShortId")
    },
    preview.domainBaseId,
    input.previewBaseRegistry
  );
  if (!hostnameResult.ok) {
    throw new PreviewMaterializationError(`Preview hostname composition failed: ${hostnameResult.error.code}.`);
  }

  return {
    id: input.id,
    workspaceId: input.workspaceId,
    configRevisionId: input.configRevisionId,
    serviceId: input.preview.target.kind === "service" ? input.previewServiceId ?? null : null,
    previewKey: preview.key,
    displayName: preview.displayName,
    targetKind: preview.target.kind,
    targetKey: preview.target.kind === "service" ? preview.target.serviceKey : "workspace",
    domainBaseId: preview.domainBaseId,
    hostnamePattern: preview.hostnamePattern,
    hostname: hostnameResult.value,
    containerPort: preview.containerPort,
    protocol: preview.protocol,
    healthPath: preview.healthPath,
    healthStatusesJson: JSON.stringify([...preview.healthStatuses]),
    startupTimeoutSeconds: preview.startupTimeoutSeconds,
    webSocketForwarding: preview.webSocketForwarding,
    desiredState: "active",
    observedState: "inactive",
    routePresent: false,
    routeRevision: null,
    runtimeGeneration: null,
    lastObservationJson: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    operationId: null,
    createdAt: input.now,
    updatedAt: input.now,
    activatedAt: null,
    deactivatedAt: null
  };
}

export function materializePreviews(input: Omit<PreviewMaterializationInput, "id" | "preview"> & {
  readonly previews: readonly ProjectOptionsV1["previews"][number][];
  readonly ids: Readonly<Record<string, string>>;
  readonly serviceIds?: Readonly<Record<string, string>>;
}): NewPreview[] {
  return input.previews.map((preview) => {
    const id = input.ids[preview.key];
    if (id === undefined) throw new PreviewMaterializationError(`Missing durable ID for preview ${preview.key}.`);
    const serviceId = preview.target.kind === "service" ? input.serviceIds?.[preview.target.serviceKey] : undefined;
    return materializePreview({
      ...input,
      id,
      preview,
      ...(serviceId === undefined ? {} : { previewServiceId: serviceId })
    });
  });
}
