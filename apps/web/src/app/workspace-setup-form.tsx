"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function WorkspaceSetupForm({ projectId, agentReachable }: { projectId: string; agentReachable: boolean }) {
  const router = useRouter();
  const [imageReference, setImageReference] = useState("node:24-bookworm");
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
        body: JSON.stringify({ imageReference })
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
      <small>Saved in immutable Project Options v1; no container is created in this milestone.</small>
      <input required maxLength={512} value={imageReference} onChange={(event) => setImageReference(event.target.value)} />
    </label>
    <button type="submit" disabled={submitting || !agentReachable}>{submitting ? "Setting up…" : "Set up primary workspace"}</button>
    {!agentReachable && <p className="message error">Start the DevSpace Agent before setup.</p>}
    {message !== "" && <p className={`message ${message.includes("ready") ? "success" : ""}`} role="status">{message}</p>}
  </form>;
}
