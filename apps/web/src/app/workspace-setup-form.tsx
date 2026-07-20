"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type PreviewBase = { readonly id: string; readonly domain: string };

export function WorkspaceSetupForm({ projectId, agentReachable, previewBases }: {
  projectId: string;
  agentReachable: boolean;
  previewBases: readonly PreviewBase[];
}) {
  const router = useRouter();
  const [imageReference, setImageReference] = useState("node:24-bookworm");
  const [configureTask, setConfigureTask] = useState(false);
  const [taskKey, setTaskKey] = useState("check");
  const [taskName, setTaskName] = useState("Check workspace");
  const [taskExecutable, setTaskExecutable] = useState("/usr/bin/printf");
  const [taskArguments, setTaskArguments] = useState("configured-task-ok\\n");
  const [configurePreview, setConfigurePreview] = useState(false);
  const [previewKey, setPreviewKey] = useState("web");
  const [previewName, setPreviewName] = useState("Web");
  const [previewContainerPort, setPreviewContainerPort] = useState("5173");
  const [previewBaseId, setPreviewBaseId] = useState(previewBases[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage("Activating Project Options, creating the managed repository, fetching, and creating the primary worktree…");
    try {
      const response = await fetch(`/api/projects/${projectId}/setup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-devspace-csrf": "1" },
        body: JSON.stringify({ imageReference, tasks: configureTask ? [{ key: taskKey, displayName: taskName,
          executable: taskExecutable, args: taskArguments.split("\n") }] : [],
          ...(configurePreview ? { preview: { key: previewKey, displayName: previewName,
            containerPort: Number(previewContainerPort), domainBaseId: previewBaseId } } : {}) })
      });
      const body = await response.json() as { message?: string };
      if (response.status === 202) {
        setMessage(body.message ?? "Workspace setup is still running safely. Submit again to continue observing it.");
        setSubmitting(false);
        return;
      }
      if (!response.ok) throw new Error(body.message ?? "Primary workspace setup failed.");
      setMessage("Primary workspace is ready and stopped.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Primary workspace setup failed.");
      setSubmitting(false);
    }
  };

  return <form className="setup-form" onSubmit={(event) => { submit(event).catch(() => setSubmitting(false)); }}>
    <label>Development container image
      <small>Saved in immutable Project Options v1 and used when the environment starts.</small>
      <input required maxLength={512} value={imageReference} onChange={(event) => setImageReference(event.target.value)} />
    </label>
    <label className="checkbox-label"><input type="checkbox" checked={configureTask}
      onChange={(event) => setConfigureTask(event.target.checked)} /> Configure a task</label>
    {configureTask && <fieldset className="task-fields"><legend>Initial configured task</legend>
      <label>Task key<input required pattern="[a-z][a-z0-9\\-]*" maxLength={80} value={taskKey}
        onChange={(event) => setTaskKey(event.target.value)} /></label>
      <label>Display name<input required maxLength={120} value={taskName}
        onChange={(event) => setTaskName(event.target.value)} /></label>
      <label>Executable<input required maxLength={512} value={taskExecutable}
        onChange={(event) => setTaskExecutable(event.target.value)} /></label>
      <label>Ordered arguments<small>One argument per line. Arguments are executed directly without a shell.</small>
      <textarea value={taskArguments} onChange={(event) => setTaskArguments(event.target.value)} rows={4} /></label>
    </fieldset>}
    <fieldset className="preview-fields"><legend>Configure a preview</legend>
      {previewBases.length === 0
        ? <p className="message">No approved preview bases are configured by an administrator, so previews cannot currently be configured.</p>
        : <>
          <label className="checkbox-label"><input type="checkbox" checked={configurePreview}
            onChange={(event) => setConfigurePreview(event.target.checked)} /> Configure a preview</label>
          {configurePreview && <div>
            <label>Preview key<input required pattern="[a-z][a-z0-9\-]*" value={previewKey}
              onChange={(event) => setPreviewKey(event.target.value)} /></label>
            <label>Display name<input required maxLength={120} value={previewName}
              onChange={(event) => setPreviewName(event.target.value)} /></label>
            <label>Container port<input required type="number" min={1} max={65535} value={previewContainerPort}
              onChange={(event) => setPreviewContainerPort(event.target.value)} /></label>
            <label>Approved preview base<select required value={previewBaseId}
              onChange={(event) => setPreviewBaseId(event.target.value)}>
              {previewBases.map((base) => <option key={base.id} value={base.id}>{base.domain}</option>)}
            </select></label>
            <small>Preview hostnames use {"{project}-{workspace}-{preview}-{shortId}"}. The workspace target uses HTTP, health path /, status 200, a 60-second startup timeout, and WebSocket forwarding.</small>
          </div>}
        </>}
    </fieldset>
    <button type="submit" disabled={submitting || !agentReachable}>{submitting ? "Setting up…" : "Set up primary workspace"}</button>
    {!agentReachable && <p className="message error">Start the DevSpace Agent before setup.</p>}
    {message !== "" && <p className={`message ${message.includes("ready") ? "success" : ""}`} role="status">{message}</p>}
  </form>;
}
