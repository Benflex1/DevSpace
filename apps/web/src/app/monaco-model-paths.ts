export interface MonacoModelPaths {
  readonly editable: string;
  readonly diffOriginal: string;
  readonly diffModified: string;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

export function monacoModelPaths(workspaceId: string, path: string, kind: "staged" | "unstaged"): MonacoModelPaths {
  const workspace = encode(workspaceId);
  const file = encode(path);
  const root = `devspace://workspace/${workspace}`;
  return {
    editable: `${root}/file/${file}`,
    diffOriginal: `${root}/diff/${kind}/original/${file}`,
    diffModified: `${root}/diff/${kind}/modified/${file}`
  };
}
