export interface EditorFileLoadState {
  readonly requestedFileKey: string | null;
}

export const emptyEditorFileLoadState: EditorFileLoadState = { requestedFileKey: null };

export function editorFileKey(projectId: string, path: string): string {
  return `${projectId}\u0000${path}`;
}

export function requestInitialEditorFileLoad(state: EditorFileLoadState, fileKey: string): { readonly state: EditorFileLoadState; readonly shouldLoad: boolean } {
  if (state.requestedFileKey === fileKey) return { state, shouldLoad: false };
  return { state: { requestedFileKey: fileKey }, shouldLoad: true };
}

export function requestExplicitEditorFileLoad(fileKey: string): { readonly state: EditorFileLoadState; readonly shouldLoad: boolean } {
  return { state: { requestedFileKey: fileKey }, shouldLoad: true };
}
