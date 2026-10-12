"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectOptionsV1 } from "@devspace/project-options";

type RevisionIdentity = { readonly revisionId: string; readonly revisionHash: string };
type ProjectOptionsRevision = {
  readonly id: string;
  readonly number: number;
  readonly hash: string;
  readonly options: ProjectOptionsV1;
};
type PendingApply = {
  readonly operationId: string;
  readonly state: string;
  readonly phase: string;
  readonly expectedRevision: RevisionIdentity;
  readonly candidateRevision: RevisionIdentity;
};
type ApplyCandidate = {
  readonly candidateRevisionId: string;
  readonly candidateRevision: RevisionIdentity;
  readonly expectedRevision: RevisionIdentity;
};
type ApprovedPreviewBase = { readonly id: string; readonly domain: string };
type OptionsSnapshot = {
  readonly activeRevision: ProjectOptionsRevision;
  readonly draft: ProjectOptionsRevision | null;
  readonly pendingApply: PendingApply | null;
  readonly approvedPreviewBases: readonly ApprovedPreviewBase[];
};
type Task = ProjectOptionsV1["tasks"][number];
type WorkspacePreview = ProjectOptionsV1["previews"][number];
type FieldErrors = Readonly<Record<string, string>>;
type ApplyState = "idle" | "applying" | "pending" | "applied" | "failed" | "stale";

const imageReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/u;

export function ProjectOptionsEditor({ projectId, runtimeState, active, onDirtyChange, onBusyChange,
  onApplyFenceChange, onApplied }: {
  readonly projectId: string;
  readonly runtimeState: string;
  readonly active: boolean;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onApplyFenceChange: (fenced: boolean) => void;
  readonly onApplied: () => void | Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<OptionsSnapshot | null>(null);
  const [options, setOptions] = useState<ProjectOptionsV1 | null>(null);
  const [portDrafts, setPortDrafts] = useState<Readonly<Record<string, string>>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverFieldErrors, setServerFieldErrors] = useState<FieldErrors>({});
  const [showValidation, setShowValidation] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyState, setApplyState] = useState<ApplyState>("idle");
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const actionInFlight = useRef(false);

  const loadSnapshot = useCallback(async (preserveApplyState = false): Promise<OptionsSnapshot | null> => {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/options`, { cache: "no-store" });
      const body = await response.json() as OptionsSnapshot & { readonly message?: string };
      if (!response.ok) throw new Error(body.message ?? "Project Options could not be loaded.");
      if (!Array.isArray(body.approvedPreviewBases)) {
        throw new Error("Approved preview bases could not be verified. Reload after the Web application is updated.");
      }
      setSnapshot(body);
      setOptions(body.draft?.options ?? body.activeRevision.options);
      setPortDrafts({});
      setReadError(null);
      setSaveError(null);
      setServerFieldErrors({});
      setShowValidation(false);
      setRefreshError(null);
      if (!preserveApplyState) {
        if (body.pendingApply !== null) {
          setApplyState("pending");
          setApplyError("Apply is still active. Continue with the same saved draft when the Agent is reachable.");
        } else {
          setApplyState("idle");
          setApplyError(null);
        }
      }
      return body;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Project Options could not be loaded.";
      setReadError(message);
      if (preserveApplyState) setRefreshError(`Project Options could not be refreshed after Apply: ${message}`);
      return null;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => { loadSnapshot().catch(() => undefined); }, [loadSnapshot]);

  const baseline = snapshot === null ? null : snapshot.draft?.options ?? snapshot.activeRevision.options;
  const unresolvedPortDraft = options !== null && Object.entries(portDrafts).some(([key, value]) => {
    const preview = options.previews.find((item) => item.key === key);
    return preview === undefined || value !== String(preview.containerPort);
  });
  const dirty = options !== null && baseline !== null
    && (JSON.stringify(options) !== JSON.stringify(baseline) || unresolvedPortDraft);
  const validation = useMemo(() => options === null || snapshot === null ? {} : validateOptions(options, snapshot.approvedPreviewBases, portDrafts),
    [options, portDrafts, snapshot]);
  const visibleErrors = showValidation ? { ...validation, ...serverFieldErrors } : serverFieldErrors;
  const pendingApply = snapshot?.pendingApply ?? null;
  const fenced = applying || pendingApply !== null || snapshot === null && runtimeState === "applying";
  const mutationBusy = saving || applying;
  const workspaceStopped = runtimeState === "stopped" || runtimeState === "absent";
  const workspaceCanApply = workspaceStopped || pendingApply !== null || applyState === "pending";
  const canEdit = snapshot !== null && !loading && !refreshing && !mutationBusy && pendingApply === null && applyState !== "applying";
  const savedDraft = snapshot?.draft ?? null;
  const applyCandidate: ApplyCandidate | null = pendingApply === null
    ? savedDraft === null ? null : {
      candidateRevisionId: savedDraft.id,
      candidateRevision: { revisionId: savedDraft.id, revisionHash: savedDraft.hash },
      expectedRevision: { revisionId: snapshot!.activeRevision.id, revisionHash: snapshot!.activeRevision.hash }
    }
    : {
      candidateRevisionId: pendingApply.candidateRevision.revisionId,
      candidateRevision: pendingApply.candidateRevision,
      expectedRevision: pendingApply.expectedRevision
    };
  const isDirty = dirty === true;
  const validationFailed = Object.keys(validation).length > 0;

  useEffect(() => { onDirtyChange(isDirty); }, [isDirty, onDirtyChange]);
  useEffect(() => { onBusyChange(mutationBusy); }, [mutationBusy, onBusyChange]);
  useEffect(() => { onApplyFenceChange(fenced); }, [fenced, onApplyFenceChange]);

  const markEdited = useCallback(() => {
    setSaveError(null);
    setServerFieldErrors({});
    setShowValidation(false);
  }, []);

  const updateImage = (value: string) => {
    markEdited();
    setOptions((current) => current === null || current.developmentEnvironment.source.kind !== "image" ? current : {
      ...current,
      developmentEnvironment: { ...current.developmentEnvironment,
        source: { ...current.developmentEnvironment.source, imageReference: value } }
    });
  };

  const updateTask = (index: number, patch: Partial<Task>) => {
    markEdited();
    setOptions((current) => current === null ? current : ({
      ...current,
      tasks: current.tasks.map((task, taskIndex) => taskIndex === index ? { ...task, ...patch } : task)
    }));
  };

  const updateTaskCommand = (index: number, patch: Partial<Task["command"]>) => {
    markEdited();
    setOptions((current) => current === null ? current : ({
      ...current,
      tasks: current.tasks.map((task, taskIndex) => taskIndex === index
        ? { ...task, command: { ...task.command, ...patch } }
        : task)
    }));
  };

  const updatePreview = (index: number, patch: Partial<WorkspacePreview>) => {
    markEdited();
    setOptions((current) => {
      if (current === null) return current;
      const previous = current.previews[index];
      if (previous === undefined) return current;
      const nextPreview = { ...previous, ...patch };
      const previews = current.previews.map((preview, previewIndex) => previewIndex === index ? nextPreview : preview);
      const existingPort = current.developmentEnvironment.ports.find((port) => port.name === previous.key);
      const ports = existingPort === undefined
        ? [...current.developmentEnvironment.ports, { name: nextPreview.key, containerPort: nextPreview.containerPort, protocol: "tcp" as const }]
        : current.developmentEnvironment.ports.map((port) => port.name === previous.key
          ? { ...port, name: nextPreview.key, containerPort: nextPreview.containerPort }
          : port);
      return { ...current, previews, developmentEnvironment: { ...current.developmentEnvironment, ports } };
    });
    if (patch.key !== undefined) {
      setPortDrafts((current) => {
        const previous = options?.previews[index];
        if (previous === undefined || previous.key === patch.key || current[previous.key] === undefined) return current;
        const next = { ...current, [patch.key!]: current[previous.key]! };
        delete next[previous.key];
        return next;
      });
    }
  };

  const addTask = () => {
    if (options === null) return;
    const key = availableKey("check", options.tasks.map((task) => task.key));
    const task: Task = {
      key,
      displayName: "Check workspace",
      command: { executable: "/usr/bin/printf", args: ["configured-task-ok\\n"], workingDirectory: ".", environment: {} },
      interactive: false,
      longRunning: false,
      timeoutSeconds: null,
      concurrencyPolicy: "reject",
      successExitCodes: [0],
      logRetentionDays: null
    };
    markEdited();
    setOptions((current) => current === null ? current : { ...current, tasks: [...current.tasks, task] });
  };

  const removeTask = (index: number) => {
    markEdited();
    setOptions((current) => current === null ? current : { ...current, tasks: current.tasks.filter((_, itemIndex) => itemIndex !== index) });
  };

  const addPreview = () => {
    if (options === null || snapshot === null) return;
    const key = availableKey("web", options.previews.map((preview) => preview.key));
    const usedPorts = new Set(options.developmentEnvironment.ports.map((port) => port.containerPort));
    const port = availablePreviewPort(usedPorts);
    const preview: WorkspacePreview = {
      key,
      displayName: availableName("Web", options.previews.map((item) => item.displayName)),
      target: { kind: "workspace" },
      containerPort: port,
      domainBaseId: snapshot.approvedPreviewBases[0]?.id ?? "",
      hostnamePattern: "{project}-{preview}-{shortId}",
      protocol: "http",
      healthPath: "/",
      healthStatuses: [200],
      startupTimeoutSeconds: 60,
      webSocketForwarding: true
    };
    markEdited();
    setOptions((current) => current === null ? current : ({
      ...current,
      previews: [...current.previews, preview],
      developmentEnvironment: { ...current.developmentEnvironment,
        ports: [...current.developmentEnvironment.ports, { name: key, containerPort: port, protocol: "tcp" }] }
    }));
  };

  const removePreview = (index: number) => {
    const preview = options?.previews[index];
    if (preview === undefined) return;
    markEdited();
    setOptions((current) => current === null ? current : ({
      ...current,
      previews: current.previews.filter((_, previewIndex) => previewIndex !== index),
      developmentEnvironment: { ...current.developmentEnvironment,
        ports: current.developmentEnvironment.ports.filter((port) => port.name !== preview.key) }
    }));
    setPortDrafts((current) => {
      if (current[preview.key] === undefined) return current;
      const next = { ...current };
      delete next[preview.key];
      return next;
    });
  };

  const saveDraft = async () => {
    if (actionInFlight.current || options === null || snapshot === null || !isDirty) return;
    setShowValidation(true);
    setSaveError(null);
    setServerFieldErrors({});
    if (Object.keys(validateOptions(options, snapshot.approvedPreviewBases, portDrafts)).length > 0) return;
    actionInFlight.current = true;
    setSaving(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/options`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-devspace-csrf": "1" },
        body: JSON.stringify({
          expectedRevision: { revisionId: snapshot.activeRevision.id, revisionHash: snapshot.activeRevision.hash },
          options
        })
      });
      const body = await response.json() as { readonly draft?: ProjectOptionsRevision; readonly message?: string; readonly field?: string };
      if (response.status === 409) {
        setApplyState("stale");
        setApplyError(body.message ?? "The active Project Options revision changed. Reload settings before saving.");
        setSaveError(null);
        return;
      }
      if (!response.ok || body.draft === undefined) {
        const message = body.message ?? "The Project Options draft could not be saved.";
        setSaveError(message);
        setServerFieldErrors(mapServerFieldError(body.field, message));
        return;
      }
      setSnapshot((current) => current === null ? current : { ...current, draft: body.draft!, pendingApply: null });
      setOptions(body.draft.options);
      setPortDrafts({});
      setApplyState("idle");
      setApplyError(null);
      setSaveError(null);
      setServerFieldErrors({});
      setShowValidation(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The Project Options draft could not be saved.");
    } finally {
      actionInFlight.current = false;
      setSaving(false);
    }
  };

  const applyDraft = async () => {
    if (actionInFlight.current || snapshot === null || applyCandidate === null || isDirty || !workspaceCanApply) return;
    actionInFlight.current = true;
    setApplying(true);
    setApplyState("applying");
    setApplyError(null);
    setSaveError(null);
    setServerFieldErrors({});
    try {
      const response = await fetch(`/api/projects/${projectId}/options/apply`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-devspace-csrf": "1" },
        body: JSON.stringify({
          expectedRevision: applyCandidate.expectedRevision,
          candidateRevisionId: applyCandidate.candidateRevisionId
        })
      });
      const body = await response.json() as {
        readonly state?: "applied" | "pending";
        readonly operationId?: string;
        readonly message?: string;
        readonly field?: string;
      };
      if (response.status === 202 || body.state === "pending") {
        const currentPending = snapshot.pendingApply;
        setSnapshot((current) => current === null ? current : { ...current, pendingApply: {
          operationId: body.operationId ?? currentPending?.operationId ?? "pending",
          state: "running",
          phase: currentPending?.phase ?? "adoption-submitted",
          expectedRevision: applyCandidate.expectedRevision,
          candidateRevision: applyCandidate.candidateRevision
        } });
        setApplyState("pending");
        setApplyError(body.message ?? "Apply is still running. Continue with the same saved draft; no new draft was created.");
        return;
      }
      if (!response.ok || body.state !== "applied") {
        const message = body.message ?? "Project Options Apply failed.";
        const stale = response.status === 409 && /revision|saved draft/iu.test(message);
        const mappedFieldErrors = mapServerFieldError(body.field, message);
        setApplyState(stale ? "stale" : "failed");
        setApplyError(message);
        if (stale) {
          setSnapshot((current) => current === null ? current : { ...current, pendingApply: null });
          if (Object.keys(mappedFieldErrors).length > 0) {
            setServerFieldErrors(mappedFieldErrors);
            setShowValidation(true);
          }
        }
        else {
          const latest = await loadSnapshot(true);
          if (latest?.activeRevision.id === applyCandidate.candidateRevisionId) {
            setApplyState("applied");
            setApplyError(null);
            try { await onApplied(); }
            catch { setRefreshError("Project Options were applied, but the Workbench could not refresh every project view."); }
          } else if (latest?.pendingApply?.candidateRevision.revisionId === applyCandidate.candidateRevisionId
            && latest.pendingApply.expectedRevision.revisionId === applyCandidate.expectedRevision.revisionId
            && latest.pendingApply.expectedRevision.revisionHash === applyCandidate.expectedRevision.revisionHash) {
            setApplyState("pending");
            setApplyError("The response did not confirm completion, but the same Apply is still pending. Continue with this saved candidate.");
          }
          if (latest?.activeRevision.id !== applyCandidate.candidateRevisionId
            && latest?.pendingApply?.candidateRevision.revisionId !== applyCandidate.candidateRevisionId
            && Object.keys(mappedFieldErrors).length > 0) {
            setServerFieldErrors(mappedFieldErrors);
            setShowValidation(true);
          }
        }
        return;
      }
      setApplyState("applied");
      setApplyError(null);
      setSnapshot((current) => current === null ? current : { ...current, pendingApply: null });
      const refreshedOptions = await loadSnapshot(true);
      if (refreshedOptions === null) setRefreshError("Project Options were applied, but the active configuration identity could not be refreshed.");
      try { await onApplied(); }
      catch { setRefreshError("Project Options were applied, but the Workbench could not refresh every project view. Refresh the Workbench to see current runtime, tasks, and previews."); }
    } catch (error) {
      setApplyState("failed");
      setApplyError(error instanceof Error
        ? `${error.message} Continue Apply to check or resume this same saved draft.`
        : "The Apply outcome could not be confirmed. Continue Apply to check or resume this same saved draft.");
      const latest = await loadSnapshot(true);
      if (latest?.activeRevision.id === applyCandidate.candidateRevisionId) {
        setApplyState("applied");
        setApplyError(null);
        try { await onApplied(); }
        catch { setRefreshError("Project Options were applied, but the Workbench could not refresh every project view."); }
      } else if (latest?.pendingApply?.candidateRevision.revisionId === applyCandidate.candidateRevisionId
        && latest.pendingApply.expectedRevision.revisionId === applyCandidate.expectedRevision.revisionId
        && latest.pendingApply.expectedRevision.revisionHash === applyCandidate.expectedRevision.revisionHash) {
        setApplyState("pending");
        setApplyError("The response was interrupted, and the same Apply is still pending. Continue with this saved candidate.");
      }
    } finally {
      actionInFlight.current = false;
      setApplying(false);
    }
  };

  const openApplyConfirmation = () => {
    if (applyCandidate === null || isDirty || !workspaceCanApply || validationFailed || mutationBusy) return;
    setApplyDialogOpen(true);
  };

  const reloadSettings = () => {
    if (isDirty && !window.confirm("Reload the saved Project Options and discard your unsaved edits?")) return;
    setApplyState("idle");
    setApplyError(null);
    loadSnapshot().catch(() => undefined);
  };

  const changePort = (index: number, value: string) => {
    const preview = options?.previews[index];
    if (preview === undefined) return;
    setPortDrafts((current) => ({ ...current, [preview.key]: value }));
    if (value.trim() === "") {
      markEdited();
      return;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      markEdited();
      return;
    }
    updatePreview(index, { containerPort: parsed });
  };

  const applyButtonText = applyState === "pending" || applyState === "failed" ? "Retry/Continue Apply" : "Apply";

  return <div className={`project-options-editor ${active ? "" : "is-inactive"}`} role="tabpanel" aria-label="Project Options">
    {loading && <p className="options-loading" role="status">Loading Project Options…</p>}
    {!loading && readError !== null && <section className="options-panel-message error" role="alert">
      <h2>Project Options could not be loaded</h2><p>{readError}</p>
      <button type="button" onClick={() => { loadSnapshot().catch(() => undefined); }}>Reload settings</button>
    </section>}
    {snapshot !== null && options !== null && <>
      <header className="project-options-header">
        <div><p className="eyebrow">Configuration</p><h1>Project Options</h1>
          <p>Update the development image, configured tasks, and workspace previews for this project.</p>
        </div>
        <div className={`options-state-chip ${statusClass(isDirty, applyState, savedDraft !== null)}`} role="status">
          {statusLabel(isDirty, applyState, savedDraft)}
        </div>
      </header>

      <section className="options-active-revision" aria-label="Active configuration">
        <div><span className="options-section-kicker">Active configuration</span>
          <strong>Revision {snapshot.activeRevision.number}</strong>
          <code title={snapshot.activeRevision.hash}>{snapshot.activeRevision.hash.slice(0, 21)}…</code>
        </div>
        {savedDraft !== null && <div className="options-draft-identity"><span className="options-section-kicker">Saved draft</span>
          <strong>Revision {savedDraft.number}</strong><code title={savedDraft.hash}>{savedDraft.hash.slice(0, 21)}…</code>
        </div>}
      </section>

      {readError !== null && <p className="options-inline-message error" role="alert">{readError} The last loaded configuration is still shown.</p>}
      {saveError !== null && <p className="options-inline-message error" role="alert">{saveError}</p>}

      {applyState === "pending" && <section className="options-apply-status pending" role="status">
        <strong>Apply pending</strong><p>{applyError ?? "Apply is still running. Continue with the same saved draft."}</p>
        <p>The active revision remains in effect until DevSpace confirms adoption. The saved candidate and expected revision are retained for retry.</p>
      </section>}
      {applyState === "applying" && <section className="options-apply-status pending" role="status"><strong>Applying</strong><p>DevSpace is adopting the saved revision. Do not close this tab until the state is confirmed.</p></section>}
      {applyState === "failed" && <section className="options-apply-status failed" role="alert">
        <strong>Failed — requires retry</strong><p>{applyError}</p>
      </section>}
      {applyState === "stale" && <section className="options-apply-status failed" role="alert">
        <strong>Revision conflict — reload required</strong><p>{applyError ?? "The active revision or saved candidate changed. Reload current settings before continuing."}</p>
        <button type="button" onClick={reloadSettings}>Reload current settings</button>
      </section>}
      {applyState === "applied" && <section className="options-apply-status success" role="status">
        <strong>Applied</strong><p>The new Project Options revision is active. The new development container will be created on the next Start.</p>
      </section>}
      {refreshError !== null && <p className="options-inline-message error" role="alert">{refreshError}</p>}

      {pendingApply !== null && <p className="options-callout">This Apply is still pending. Editing and Save Draft are paused so the saved candidate keeps its exact identity.</p>}
      {!workspaceStopped && pendingApply === null && <p className="options-callout warning" role="status">
        Stop the workspace with the normal Workbench control before Apply. Project Options will not stop it for you.
      </p>}

      <section className="options-editor-section" aria-labelledby="options-image-heading">
        <div className="options-section-heading"><div><h2 id="options-image-heading">Development container</h2>
          <p>Used the next time this workspace starts.</p></div>
        </div>
        <label className="options-field">Development container image
          <input aria-label="Development container image" value={imageReference(options)} maxLength={512}
            disabled={!canEdit || options.developmentEnvironment.source.kind !== "image"}
            aria-invalid={visibleErrors.imageReference !== undefined}
            onChange={(event) => updateImage(event.target.value)} />
          {options.developmentEnvironment.source.kind !== "image" && <small>This revision uses a different source type. It is preserved unchanged and cannot be edited in this release.</small>}
          <FieldError error={visibleErrors.imageReference} />
        </label>
      </section>

      <section className="options-editor-section" aria-labelledby="options-tasks-heading">
        <div className="options-section-heading"><div><h2 id="options-tasks-heading">Configured tasks</h2>
          <p>Commands run directly with ordered arguments; no shell is implied.</p></div>
          <button type="button" disabled={!canEdit} onClick={addTask}>Add task</button>
        </div>
        {options.tasks.length === 0 && <p className="options-empty">No configured tasks.</p>}
        {options.tasks.map((task, index) => {
          const label = task.displayName || task.key || `Task ${index + 1}`;
          return <fieldset className="options-item-card" key={index} disabled={!canEdit}>
            <legend>{label}</legend>
            <div className="options-field-grid">
              <label className="options-field">Key
                <input aria-label={`Task ${task.key} key`} value={task.key}
                  aria-invalid={visibleErrors[`tasks.${index}.key`] !== undefined}
                  onChange={(event) => updateTask(index, { key: event.target.value })} />
                <FieldError error={visibleErrors[`tasks.${index}.key`]} />
              </label>
              <label className="options-field">Name
                <input aria-label={`Task ${task.key} name`} value={task.displayName} maxLength={120}
                  aria-invalid={visibleErrors[`tasks.${index}.displayName`] !== undefined}
                  onChange={(event) => updateTask(index, { displayName: event.target.value })} />
                <FieldError error={visibleErrors[`tasks.${index}.displayName`]} />
              </label>
              <label className="options-field options-field-wide">Executable
                <input aria-label={`Task ${task.key} executable`} value={task.command.executable} maxLength={512}
                  aria-invalid={visibleErrors[`tasks.${index}.executable`] !== undefined}
                  onChange={(event) => updateTaskCommand(index, { executable: event.target.value })} />
                <FieldError error={visibleErrors[`tasks.${index}.executable`]} />
              </label>
            </div>
            <div className="options-arguments-heading"><div><strong>Ordered arguments</strong><small>Each row is passed as one argument, in order.</small></div>
              <button type="button" onClick={() => updateTaskCommand(index, { args: [...task.command.args, ""] })}>Add argument</button>
            </div>
            {task.command.args.map((argument, argumentIndex) => <div className="options-argument-row" key={argumentIndex}>
              <label className="options-field"><span className="visually-hidden">Argument {argumentIndex + 1}</span>
                <input aria-label={`Task ${task.key} argument ${argumentIndex + 1}`} value={argument} maxLength={2048}
                  aria-invalid={visibleErrors[`tasks.${index}.args`] !== undefined}
                  onChange={(event) => updateTaskCommand(index, { args: task.command.args.map((current, itemIndex) => itemIndex === argumentIndex ? event.target.value : current) })} />
              </label>
              <button type="button" className="options-remove-button" aria-label={`Remove argument ${argumentIndex + 1} from ${task.key}`}
                onClick={() => updateTaskCommand(index, { args: task.command.args.filter((_, itemIndex) => itemIndex !== argumentIndex) })}>Remove</button>
            </div>)}
            <FieldError error={visibleErrors[`tasks.${index}.args`]} />
            <button type="button" className="options-remove-button" onClick={() => removeTask(index)}>Remove task</button>
          </fieldset>;
        })}
        <FieldError error={visibleErrors.tasks} />
      </section>

      <section className="options-editor-section" aria-labelledby="options-previews-heading">
        <div className="options-section-heading"><div><h2 id="options-previews-heading">Workspace previews</h2>
          <p>Each preview uses an administrator-approved domain base.</p></div>
          <button type="button" disabled={!canEdit} onClick={addPreview}>Add preview</button>
        </div>
        {options.previews.length === 0 && <p className="options-empty">No configured previews.</p>}
        {options.previews.map((preview, index) => {
          const label = preview.displayName || preview.key || `Preview ${index + 1}`;
          const approved = snapshot.approvedPreviewBases.some((base) => base.id === preview.domainBaseId);
          const portValue = portDrafts[preview.key] ?? String(preview.containerPort);
          return <fieldset className="options-item-card" key={index} disabled={!canEdit}>
            <legend>{label}</legend>
            {preview.target.kind !== "workspace" && <p className="options-inline-message error">This service preview is preserved unchanged, but this Apply flow supports workspace previews only.</p>}
            <div className="options-field-grid">
              <label className="options-field">Key
                <input aria-label={`Preview ${preview.displayName} key`} value={preview.key}
                  aria-invalid={visibleErrors[`previews.${index}.key`] !== undefined}
                  onChange={(event) => updatePreview(index, { key: event.target.value })} />
                <FieldError error={visibleErrors[`previews.${index}.key`]} />
              </label>
              <label className="options-field">Name
                <input aria-label={`Preview ${preview.displayName} name`} value={preview.displayName} maxLength={120}
                  aria-invalid={visibleErrors[`previews.${index}.displayName`] !== undefined}
                  onChange={(event) => updatePreview(index, { displayName: event.target.value })} />
                <FieldError error={visibleErrors[`previews.${index}.displayName`]} />
              </label>
              <label className="options-field">Container port
                <input aria-label={`Preview ${preview.displayName} container port`} type="number" min={1} max={65535} step={1}
                  value={portValue} aria-invalid={visibleErrors[`previews.${index}.containerPort`] !== undefined}
                  onChange={(event) => changePort(index, event.target.value)} />
                <FieldError error={visibleErrors[`previews.${index}.containerPort`]} />
              </label>
              <label className="options-field">Approved domain base
                <select aria-label={`Preview ${preview.displayName} approved domain base`} value={preview.domainBaseId}
                  aria-invalid={visibleErrors[`previews.${index}.domainBaseId`] !== undefined}
                  onChange={(event) => updatePreview(index, { domainBaseId: event.target.value })}>
                  {!approved && <option value={preview.domainBaseId}>{preview.domainBaseId || "Choose an approved base"} (no longer approved)</option>}
                  {snapshot.approvedPreviewBases.map((base) => <option key={base.id} value={base.id}>{base.domain}</option>)}
                </select>
                <FieldError error={visibleErrors[`previews.${index}.domainBaseId`]} />
              </label>
            </div>
            <button type="button" className="options-remove-button" onClick={() => removePreview(index)}>Remove preview</button>
          </fieldset>;
        })}
        <FieldError error={visibleErrors.previews} />
        <FieldError error={visibleErrors.configuration} />
      </section>

      <section className="options-save-actions" aria-label="Project Options actions">
        <div><p>Save Draft stores an immutable candidate. Apply activates only that saved revision.</p>
          <p className="options-retirement-note">Apply retires the existing stopped development container even for task-only changes. <code>/workspace</code>, Git data, and Agent-owned harness state remain persistent; writes made only to the container's disposable writable layer may be lost.</p>
        </div>
        <div className="options-action-buttons">
          <button type="button" className="secondary" disabled={!canEdit || !isDirty} onClick={() => { saveDraft().catch(() => undefined); }}>
            {saving ? "Saving…" : "Save Draft"}
          </button>
          {applyCandidate !== null && <button type="button" disabled={!workspaceCanApply || isDirty || mutationBusy || applyState === "stale" || validationFailed}
            onClick={openApplyConfirmation}>
            {applying ? "Applying…" : applyButtonText}
          </button>}
        </div>
      </section>
      {refreshError !== null && <button type="button" className="options-reload-button" disabled={refreshing} onClick={() => { loadSnapshot(true).catch(() => undefined); }}>
        {refreshing ? "Refreshing…" : "Refresh configuration"}
      </button>}

      {applyDialogOpen && <div className="options-confirm-backdrop">
        <section className="options-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="options-confirm-title" aria-describedby="options-confirm-description">
          <h2 id="options-confirm-title">Apply Project Options?</h2>
          <p id="options-confirm-description">Applying retires the existing stopped development container, including for task-only changes. <code>/workspace</code>, Git data, and Agent-owned harness state remain persistent, but writes made only to the container's disposable writable layer may be lost.</p>
          <p>The workspace must already be stopped. DevSpace will not stop it for you.</p>
          <div className="options-confirm-actions">
            <button type="button" className="secondary" onClick={() => setApplyDialogOpen(false)}>Cancel</button>
            <button type="button" disabled={applying} onClick={() => {
              setApplyDialogOpen(false);
              applyDraft().catch(() => undefined);
            }}>{pendingApply !== null || applyState === "pending" || applyState === "failed" ? "Continue Apply" : "Confirm Apply"}</button>
          </div>
        </section>
      </div>}
    </>}
  </div>;
}

function imageReference(options: ProjectOptionsV1): string {
  return options.developmentEnvironment.source.kind === "image" ? options.developmentEnvironment.source.imageReference : "";
}

function availableKey(base: string, existing: readonly string[]): string {
  if (!existing.includes(base)) return base;
  let suffix = 2;
  while (existing.includes(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function availableName(base: string, existing: readonly string[]): string {
  if (!existing.includes(base)) return base;
  let suffix = 2;
  while (existing.includes(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

function availablePreviewPort(usedPorts: ReadonlySet<number>): number {
  for (const candidate of [5173, 3000, 8080, 8000, 4173]) {
    if (!usedPorts.has(candidate)) return candidate;
  }
  for (let candidate = 1024; candidate <= 65535; candidate += 1) {
    if (!usedPorts.has(candidate)) return candidate;
  }
  return 0;
}

function validateOptions(options: ProjectOptionsV1, approvedBases: readonly ApprovedPreviewBase[], portDrafts: Readonly<Record<string, string>>): Record<string, string> {
  const errors: Record<string, string> = {};
  const image = imageReference(options);
  if (image.length < 1 || image.length > 512 || !imageReferencePattern.test(image) || image.includes("://")
    || [...image].some((character) => (character.codePointAt(0) ?? 0) <= 31 || (character.codePointAt(0) ?? 0) === 127)) {
    errors.imageReference = "Enter a valid development container image reference.";
  }
  const taskKeys = new Set<string>();
  for (const [index, task] of options.tasks.entries()) {
    if (!/^[a-z][a-z0-9-]*$/u.test(task.key)) errors[`tasks.${index}.key`] = "Use a lowercase key starting with a letter and containing only letters, numbers, or hyphens.";
    else if (taskKeys.has(task.key)) errors[`tasks.${index}.key`] = "Task keys must be unique.";
    taskKeys.add(task.key);
    if (task.displayName.trim().length === 0 || task.displayName.length > 120) errors[`tasks.${index}.displayName`] = "Enter a task name up to 120 characters.";
    if (task.command.executable.trim().length === 0 || task.command.executable.length > 512) errors[`tasks.${index}.executable`] = "Enter a task executable.";
    if (task.command.args.length > 100 || task.command.args.some((argument) => argument.length > 2048)) errors[`tasks.${index}.args`] = "Use at most 100 arguments, each no longer than 2,048 characters.";
  }

  const previewKeys = new Set<string>();
  const firstPreviewIndexByPort = new Map<number, number>();
  const expectedPorts: Array<{ name: string; containerPort: number; protocol: "tcp" }> = [];
  for (const [index, preview] of options.previews.entries()) {
    if (!/^[a-z][a-z0-9-]*$/u.test(preview.key)) errors[`previews.${index}.key`] = "Use a lowercase key starting with a letter and containing only letters, numbers, or hyphens.";
    else if (previewKeys.has(preview.key)) errors[`previews.${index}.key`] = "Preview keys must be unique.";
    previewKeys.add(preview.key);
    if (preview.displayName.trim().length === 0 || preview.displayName.length > 120) errors[`previews.${index}.displayName`] = "Enter a preview name up to 120 characters.";
    const portValue = portDrafts[preview.key] ?? String(preview.containerPort);
    const port = Number(portValue);
    if (portValue.trim() === "" || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      errors[`previews.${index}.containerPort`] = "Enter a container port from 1 to 65535.";
    } else {
      const firstIndex = firstPreviewIndexByPort.get(port);
      if (firstIndex === undefined) firstPreviewIndexByPort.set(port, index);
      else {
        const error = "Workspace preview ports must be unique.";
        errors[`previews.${firstIndex}.containerPort`] = error;
        errors[`previews.${index}.containerPort`] = error;
      }
    }
    if (!approvedBases.some((base) => base.id === preview.domainBaseId)) errors[`previews.${index}.domainBaseId`] = "Choose an approved preview base.";
    if (preview.target.kind !== "workspace") errors.previews = "This saved revision contains a service preview. It is preserved, but this Apply flow supports workspace previews only.";
    expectedPorts.push({ name: preview.key, containerPort: preview.containerPort, protocol: "tcp" });
  }
  const sortPorts = (ports: readonly { name: string; containerPort: number; protocol: "tcp" }[]) => [...ports]
    .sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(sortPorts(options.developmentEnvironment.ports)) !== JSON.stringify(sortPorts(expectedPorts))) {
    errors.previews ??= "Workspace ports must match the configured previews. Preview edits update their linked container ports automatically.";
  }
  const unsupported = unsupportedRuntimeSetting(options);
  if (unsupported !== null) errors.configuration = `${unsupported} It is preserved unchanged, but this release cannot compile it for Apply.`;
  return errors;
}

function unsupportedRuntimeSetting(options: ProjectOptionsV1): string | null {
  const development = options.developmentEnvironment;
  if (development.source.kind !== "image") return "This revision uses a non-image development source.";
  if (options.services.length > 0) return "This revision contains supporting services.";
  if (options.namedVolumes.length > 0) return "This revision contains named volumes.";
  if (development.volumes.length > 0) return "This revision contains development-container volume mounts.";
  if (development.setupSteps.length > 0) return "This revision contains setup steps.";
  if (development.passwordlessSudo) return "This revision enables passwordless sudo.";
  if (Object.values(development.environment).some((binding) => binding.kind !== "literal")) return "This revision contains non-literal development environment bindings.";
  return null;
}

function mapServerFieldError(field: string | undefined, message: string): FieldErrors {
  if (field?.includes("image") === true || /image reference/iu.test(message)) return { imageReference: message };
  const taskField = field?.match(/^tasks\.(\d+)\.(key|displayName|executable|args|command\.executable|command\.args)$/u);
  if (taskField !== null && taskField !== undefined) {
    return { [`tasks.${taskField[1]}.${taskField[2]?.replace("command.", "")}`]: message };
  }
  const previewField = field?.match(/^previews\.(\d+)\.(key|displayName|containerPort|domainBaseId)$/u);
  if (previewField !== null && previewField !== undefined) {
    return { [`previews.${previewField[1]}.${previewField[2]}`]: message };
  }
  if (field?.includes("tasks") === true || /task definition|task key/iu.test(message)) return { tasks: message };
  if (field?.includes("preview") === true || field?.includes("ports") === true || /preview base|preview configuration|workspace ports/iu.test(message)) return { previews: message };
  if (field?.includes("developmentEnvironment") === true) return { configuration: message };
  return {};
}

function statusLabel(dirty: boolean, state: ApplyState, draft: ProjectOptionsRevision | null): string {
  if (state === "applying") return "Applying";
  if (state === "pending") return "Apply pending";
  if (state === "applied") return "Applied";
  if (state === "failed") return "Failed — requires retry";
  if (state === "stale") return "Revision conflict";
  if (dirty) return "Unsaved edits";
  if (draft !== null) return `Saved draft · revision ${draft.number}`;
  return "Active configuration";
}

function statusClass(dirty: boolean, state: ApplyState, hasDraft: boolean): string {
  if (state === "applied") return "success";
  if (state === "failed" || state === "stale") return "failed";
  if (state === "applying" || state === "pending") return "pending";
  if (dirty) return "dirty";
  return hasDraft ? "draft" : "active";
}

function FieldError({ error }: { readonly error: string | undefined }) {
  return error === undefined ? null : <small className="options-field-error" role="alert">{error}</small>;
}
