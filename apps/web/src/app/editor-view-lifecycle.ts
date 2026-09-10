export function editorViewVisibility(mode: "edit" | "changes"): { readonly editHidden: boolean; readonly changesHidden: boolean } {
  return { editHidden: mode !== "edit", changesHidden: mode !== "changes" };
}
