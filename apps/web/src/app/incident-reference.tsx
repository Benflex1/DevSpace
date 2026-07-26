export function IncidentReference({ incidentId }: { readonly incidentId?: string | undefined }) {
  if (incidentId === undefined) return null;
  return <span className="incident-reference">Reference ID: <code>{incidentId}</code></span>;
}
